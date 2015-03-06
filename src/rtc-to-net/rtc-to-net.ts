// Server which handles SOCKS connections over WebRTC datachannels and send them
// out to the internet and sending back over WebRTC the responses.

/// <reference path='../../../third_party/typings/es6-promise/es6-promise.d.ts' />
/// <reference path='../../../third_party/freedom-typings/freedom-module-env.d.ts' />
/// <reference path='../../../third_party/ipaddrjs/ipaddrjs.d.ts' />

import freedomTypes = require('freedom.types');
import ipaddr = require('ipaddr.js');

import arraybuffers = require('../../../third_party/uproxy-lib/arraybuffers/arraybuffers');
import peerconnection = require('../../../third_party/uproxy-lib/webrtc/peerconnection');
import handler = require('../../../third_party/uproxy-lib/handler/queue');

import churn = require('../churn/churn');
import net = require('../net/net.types');
import tcp = require('../net/tcp');
import socks = require('../socks-common/socks-headers');

import logging = require('../../../third_party/uproxy-lib/logging/logging');

module RtcToNet {

  var log :logging.Log = new logging.Log('RtcToNet');

  export interface ProxyConfig {
    // If |allowNonUnicast === false| then any proxy attempt that results
    // in a non-unicast (e.g. local network) address will fail.
    allowNonUnicast :boolean;
  }

  export interface HandlerQueueSnapshot {
    size :number;
    handling :boolean;
  }

  export interface SocketSnapshot {
    sent :number;
    received :number;
    queue :HandlerQueueSnapshot;
  }

  export interface DataChannelSnapshot {
    sent :number;
    received :number;
    buffered :number;
    queue :HandlerQueueSnapshot;
  }

  export interface SessionSnapshot {
    name :string;
    channel :DataChannelSnapshot;
    socket :SocketSnapshot;
  }

  export interface RtcToNetSnapshot {
    sessions :SessionSnapshot[];
  }

  // The |RtcToNet| class holds a peer-connection and all its associated
  // proxied connections.
  // TODO: Extract common code for this and SocksToRtc:
  //         https://github.com/uProxy/uproxy/issues/977
  export class RtcToNet {
    // Time between outputting snapshots.
    private static SNAPSHOTTING_INTERVAL_MS = 5000;

    // Configuration for the proxy endpoint. Note: all sessions share the same
    // (externally provided) proxyconfig.
    public proxyConfig :ProxyConfig;

    // Message handler queues to/from the peer.
    public signalsForPeer :handler.QueueHandler<peerconnection.SignallingMessage, void>;

    // The two Queues below only count bytes transferred between the SOCKS
    // client and the remote host(s) the client wants to connect to. WebRTC
    // overhead (DTLS headers, ICE initiation, etc.) is not included (because
    // WebRTC does not provide easy access to that data) nor is SOCKS
    // protocol-related data (because it's sent via string messages).
    // All Sessions created in one instance of RtcToNet will share and
    // push numbers to the same queues (belonging to that instance of RtcToNet).
    // Queue of the number of bytes received from the peer. Handler is typically
    // defined in the class that creates an instance of RtcToNet.
    public bytesReceivedFromPeer :handler.Queue<number, void> =
        new handler.Queue<number, void>();

    // Queue of the number of bytes sent to the peer. Handler is typically
    // defined in the class that creates an instance of RtcToNet.
    public bytesSentToPeer :handler.Queue<number, void> =
        new handler.Queue<number, void>();

    // Fulfills once the module is ready to allocate sockets.
    // Rejects if a peerconnection could not be made for any reason.
    public onceReady :Promise<void>;

    // Call this to initiate shutdown.
    private fulfillStopping_ :() => void;
    private onceStopping_ = new Promise((F, R) => {
      this.fulfillStopping_ = F;
    });

    // Fulfills once the module has terminated and the peerconnection has
    // been shutdown.
    // This can happen in response to:
    //  - startup failure
    //  - peerconnection termination
    //  - manual invocation of close()
    // Should never reject.
    // TODO: rename onceStopped, ala SocksToRtc (API breakage).
    public onceClosed :Promise<void>;

    // The connection to the peer that is acting as a proxy client.
    private peerConnection_
        :peerconnection.PeerConnection<peerconnection.SignallingMessage> = null;

    // The |sessions_| map goes from WebRTC data-channel labels to the Session.
    // Most of the wiring to manage this relationship happens via promises. We
    // need this only for data being received from a peer-connection data
    // channel get raised with data channel label. TODO:
    // https://github.com/uProxy/uproxy/issues/315 when closed allows
    // DataChannel and PeerConnection to be used directly and not via a freedom
    // interface. Then all work can be done by promise binding and this can be
    // removed.
    private sessions_ :{ [channelLabel:string] : Session } = {};

    // As configure() but handles creation of peerconnection.
    constructor(
        pcConfig?:freedom_RTCPeerConnection.RTCConfiguration,
        proxyConfig?:ProxyConfig,
        obfuscate?:boolean) {
      if (pcConfig) {
        var pc :freedom_RTCPeerConnection.RTCPeerConnection =
            freedom['core.rtcpeerconnection'](pcConfig);
        this.start(
            proxyConfig,
            obfuscate ?
                new churn.Connection(pc) :
                new peerconnection.PeerConnectionClass(pc));
      }
    }

    // Starts with the supplied peerconnection.
    // Returns this.onceReady.
    public start = (
        proxyConfig:ProxyConfig,
        peerconnection:peerconnection.PeerConnection<
          peerconnection.SignallingMessage>)
        : Promise<void> => {
      if (this.peerConnection_) {
        throw new Error('already configured');
      }
      this.proxyConfig = proxyConfig;
      this.peerConnection_ = peerconnection;

      this.signalsForPeer = this.peerConnection_.signalForPeerQueue;
      this.peerConnection_.peerOpenedChannelQueue.setSyncHandler(
          this.onPeerOpenedChannel_);

      // TODO: this.onceReady should reject if |this.onceStopping_|
      // fulfills first.  https://github.com/uProxy/uproxy/issues/760
      this.onceReady = this.peerConnection_.onceConnected.then(() => {});
      this.onceReady.catch(this.fulfillStopping_);
      this.peerConnection_.onceDisconnected
        .then(() => {
          log.debug('peerconnection terminated');
        }, (e:Error) => {
          log.error('peerconnection terminated with error: %1', [e.message]);
        })
        .then(this.fulfillStopping_, this.fulfillStopping_);
      this.onceClosed = this.onceStopping_.then(this.stopResources_);

      // Uncomment this to see instrumentation data in the console.
      //this.onceReady.then(this.initiateSnapshotting);

      return this.onceReady;
    }

    // Loops until onceClosed fulfills.
    public initiateSnapshotting = () => {
      var loop = true;
      this.onceClosed.then(() => {
        loop = false;
      });
      var writeSnapshot = () => {
        this.getSnapshot().then((snapshot:RtcToNetSnapshot) => {
          log.info('snapshot: %1', [JSON.stringify(snapshot)]);
        });
        if (loop) {
          setTimeout(writeSnapshot, RtcToNet.SNAPSHOTTING_INTERVAL_MS);
        }
      };
      writeSnapshot();
    }

    // Snapshots the state of this RtcToNet instance.
    private getSnapshot = () : Promise<RtcToNetSnapshot> => {
      var promises :Promise<SessionSnapshot>[] = [];
      Object.keys(this.sessions_).forEach((key:string) => {
        promises.push(this.sessions_[key].getSnapshot())
      });
      return Promise.all(promises).then((sessionSnapshots:SessionSnapshot[]) => {
        return {
          sessions: sessionSnapshots
        };
      });
    }

    private onPeerOpenedChannel_ = (channel:peerconnection.DataChannel) => {
      var channelLabel = channel.getLabel();
      log.info('associating session %1 with new datachannel', [channelLabel]);

      var session = new Session(
          channel,
          this.proxyConfig,
          this.bytesReceivedFromPeer,
          this.bytesSentToPeer);
      this.sessions_[channelLabel] = session;
      session.start().catch((e:Error) => {
        log.warn('session %1 failed to connect to remote endpoint: %2', [
            channelLabel, e.message]);
      });

      var discard = () => {
        delete this.sessions_[channelLabel];
        log.info('discarded session %1 (%2 remaining)', [
            channelLabel, Object.keys(this.sessions_).length]);
        };
      session.onceStopped().then(discard, (e:Error) => {
        log.error('session %1 terminated with error: %2', [
            channelLabel, e.message]);
        discard();
      });
    }

    // Initiates shutdown of the peerconnection.
    // Returns onceClosed.
    // TODO: rename stop, ala SocksToRtc (API breakage).
    public close = () : Promise<void> => {
      log.debug('stop requested');
      this.fulfillStopping_();
      return this.onceClosed;
    }

    // Shuts down the peerconnection, fulfilling once it has terminated.
    // Since its close() method should never throw, this should never reject.
    // TODO: close all sessions before fulfilling
    private stopResources_ = () : Promise<void> => {
      log.debug('freeing resources');
      return new Promise<void>((F, R) => { this.peerConnection_.close(); F(); });
    }

    public handleSignalFromPeer = (signal:peerconnection.SignallingMessage) : void => {
      this.peerConnection_.handleSignalMessage(signal);
    }

    public toString = () : string => {
      var ret :string;
      var sessionsAsStrings :string[] = [];
      var label :string;
      for (label in this.sessions_) {
        sessionsAsStrings.push(this.sessions_[label].longId());
      }
      ret = JSON.stringify({ sessions_: sessionsAsStrings });
      return ret;
    }

  }  // class RtcToNet


  // A Tcp connection and its data-channel on the peer connection.
  //
  // CONSIDER: when we have a lightweight webrtc provider, we can use the
  // DataChannel class directly here instead of the awkward pairing of
  // peerConnection with chanelLabel.
  //
  // CONSIDER: this and the socks-rtc session are similar: maybe abstract
  // common parts into a super-class this inherits from?
  export class Session {
    private tcpConnection_ :tcp.Connection;

    // Fulfills once a connection has been established with the remote peer.
    // Rejects if a connection cannot be made for any reason.
    public onceReady :Promise<void>;

    // Call this to initiate shutdown.
    private fulfillStopping_ :() => void;
    private onceStopping_ = new Promise((F, R) => {
      this.fulfillStopping_ = F;
    });

    // Fulfills once the session has terminated and the TCP connection
    // and datachannel have been shutdown.
    // This can happen in response to:
    //  - startup failure
    //  - TCP connection or datachannel termination
    //  - manual invocation of close()
    // Should never reject.
    private onceStopped_ :Promise<void>;
    public onceStopped = () : Promise<void> => { return this.onceStopped_; }

    // Getters.
    public channelLabel = () : string => { return this.dataChannel_.getLabel(); }

    private socketSentBytes_ :number = 0;
    private socketReceivedBytes_ :number = 0;
    private channelSentBytes_ :number = 0;
    private channelReceivedBytes_ :number = 0;

    // The supplied datachannel must already be successfully established.
    constructor(
        private dataChannel_:peerconnection.DataChannel,
        private proxyConfig_:ProxyConfig,
        private bytesReceivedFromPeer_:handler.Queue<number,void>,
        private bytesSentToPeer_:handler.Queue<number,void>) {}

    // Returns onceReady.
    public start = () : Promise<void> => {
      this.onceReady = this.receiveEndpointFromPeer_()
        .then(this.getTcpConnection_, (e:Error) => {
          // TODO: Add a unit test for this case.
          this.replyToPeer_(socks.Reply.UNSUPPORTED_COMMAND);
          throw e;
        })
        .then((tcpConnection) => {
          this.tcpConnection_ = tcpConnection;
          // Shutdown once the TCP connection terminates.
          this.tcpConnection_.onceClosed.then((kind:tcp.SocketCloseKind) => {
            log.info('%1: socket closed (%2)', [
                this.longId(),
                tcp.SocketCloseKind[kind]]);
          })
          .then(this.fulfillStopping_);
          return this.tcpConnection_.onceConnected;
        })
        .then((info:tcp.ConnectionInfo) => {
          log.info('%1: connected to remote endpoint', [this.longId()]);
          log.debug('%1: bound address: %2', [this.longId(),
              JSON.stringify(info.bound)]);
          var reply = this.getReplyFromInfo_(info);
          this.replyToPeer_(reply, info);
        }, (e:any) => {
          // TODO: e is actually a freedom.Error (uproxy-lib 20+)
          // If this.tcpConnection_ is not defined, then getTcpConnection_
          // failed and we've already replied with UNSUPPORTED_COMMAND.
          if (this.tcpConnection_) {
            var reply = this.getReplyFromError_(e);
            this.replyToPeer_(reply);
          }
          throw e;
        });

      this.onceReady.then(this.linkSocketAndChannel_, this.fulfillStopping_);

      this.dataChannel_.onceClosed
      .then(() => {
        log.info('%1: datachannel closed', [this.longId()]);
      })
      .then(this.fulfillStopping_);

      this.onceStopped_ = this.onceStopping_.then(this.stopResources_);

      return this.onceReady;
    }

    // Initiates shutdown of the TCP connection and peerconnection.
    // Returns onceStopped.
    public stop = () : Promise<void> => {
      log.debug('%1: stop requested', [this.longId()]);
      this.fulfillStopping_();
      return this.onceStopped_;
    }

    // Closes the TCP connection and datachannel if they haven't already
    // closed, fulfilling once both have closed. Since neither object's
    // close() methods should ever reject, this should never reject.
    private stopResources_ = () : Promise<void> => {
      log.debug('%1: freeing resources', [this.longId()]);
      // DataChannel.close() returns void, implying that the shutdown is
      // effectively immediate.  However, we wrap it in a promise to ensure
      // that any exception is sent to the Promise.catch, rather than
      // propagating synchronously up the stack.
      var shutdownPromises :Promise<any>[] = [
        new Promise((F, R) => { this.dataChannel_.close(); F(); })
      ];
      if (this.tcpConnection_) {
        shutdownPromises.push(this.tcpConnection_.close());
      }
      return Promise.all(shutdownPromises).then((discard:any) => {});
    }

    // Fulfills with the endpoint requested by the SOCKS client.
    // Rejects if the received message is not for an endpoint
    // or if the received endpoint cannot be parsed.
    // TODO: needs tests (mocked by several tests)
    private receiveEndpointFromPeer_ = () : Promise<net.Endpoint> => {
      return new Promise((F,R) => {
        this.dataChannel_.dataFromPeerQueue.setSyncNextHandler((data:peerconnection.Data) => {
          if (!data.str) {
            R(new Error('received non-string data from peer: ' +
                JSON.stringify(data)));
            return;
          }
          try {
            var r :any = JSON.parse(data.str);
            if (!socks.isValidRequest(r)) {
              R(new Error('received invalid request from peer: ' +
                  JSON.stringify(data.str)));
              return;
            }
            var request :socks.Request = r;
            if (request.command != socks.Command.TCP_CONNECT) {
              R(new Error('unexpected type for endpoint message'));
              return;
            }
            log.info('%1: received endpoint from peer: %2', [
                this.longId(), JSON.stringify(request.endpoint)]);
            F(request.endpoint);
            return;
          } catch (e) {
            R(new Error('received malformed message during handshake: ' +
                data.str));
            return;
          }
        });
      });
    }

    private getTcpConnection_ = (endpoint:net.Endpoint) : tcp.Connection => {
      if (ipaddr.isValid(endpoint.address) &&
          !this.isAllowedAddress_(endpoint.address)) {
        this.replyToPeer_(socks.Reply.NOT_ALLOWED);
        throw new Error('tried to connect to disallowed address: ' +
                        endpoint.address);
      }
      return new tcp.Connection({endpoint: endpoint});
    }

    // Fulfills once the connected endpoint has been returned to the SOCKS client.
    // Rejects if the endpoint cannot be sent to the SOCKS client.
    private replyToPeer_ = (reply:socks.Reply, info?:tcp.ConnectionInfo)
        : Promise<void> => {
      var response :socks.Response = {
        reply: reply,
        endpoint: info ? info.bound : undefined
      };
      return this.dataChannel_.send({
        str: JSON.stringify(response)
      }).then(() => {
        if (reply != socks.Reply.SUCCEEDED) {
          this.stop();
        }
      });
    }

    private getReplyFromInfo_ = (info:tcp.ConnectionInfo) : socks.Reply => {
      // TODO: This code should really return socks.Reply.NOT_ALLOWED,
      // but due to port-scanning concerns we return a generic error instead.
      // See https://github.com/uProxy/uproxy/issues/809
      return this.isAllowedAddress_(info.remote.address) ?
          socks.Reply.SUCCEEDED : socks.Reply.FAILURE;
    }

    private getReplyFromError_ = (e:freedom.Error) : socks.Reply => {
      var reply :socks.Reply = socks.Reply.FAILURE;
      if (e.errcode == 'TIMED_OUT') {
        reply = socks.Reply.TTL_EXPIRED;
      } else if (e.errcode == 'NETWORK_CHANGED') {
        reply = socks.Reply.NETWORK_UNREACHABLE;
      } else if (e.errcode == 'CONNECTION_RESET' ||
                 e.errcode == 'CONNECTION_REFUSED') {
        // Due to port-scanning concerns, we return a generic error if the user
        // has blocked local network access and we are not sure if the requested
        // address might be on the local network.
        // See https://github.com/uProxy/uproxy/issues/809
        if (this.proxyConfig_.allowNonUnicast) {
          reply = socks.Reply.CONNECTION_REFUSED;
        }
      }
      // TODO: report ConnectionInfo in cases where a port was bound.
      // Blocked by https://github.com/uProxy/uproxy/issues/803
      return reply;
    }

    // Sends a packet over the data channel.
    // Invoked when a packet is received over the TCP socket.
    private sendOnChannel_ = (data:ArrayBuffer) : void => {
      this.socketReceivedBytes_ += data.byteLength;
      log.debug('%1: socket received %2 bytes', [
          this.longId(),
          data.byteLength]);
      this.dataChannel_.send({buffer: data}).then(() => {
        this.bytesSentToPeer_.handle(data.byteLength);
        this.channelSentBytes_ += data.byteLength;
      }).catch((e:Error) => {
        log.error('%1: failed to send data on datachannel: %2', [
            this.longId(),
            e.message]);
      });
    }

    // Sends a packet over the TCP socket.
    // Invoked when a packet is received over the data channel.
    private sendOnSocket_ = (data:WebRtc.Data) : void => {
      this.channelReceivedBytes_ += data.buffer.byteLength;
      if (!data.buffer) {
        log.error('%1: received non-buffer data from datachannel', [
            this.longId()]);
        return;
      }
      log.debug('%1: datachannel received %2 bytes', [
          this.longId(),
          data.buffer.byteLength]);
      this.bytesReceivedFromPeer_.handle(data.buffer.byteLength);
      this.tcpConnection_.send(data.buffer).then(() => {
        this.socketSentBytes_ += data.buffer.byteLength;
      }).catch((e:any) => {
        // TODO: e is actually a freedom.Error (uproxy-lib 20+)
        // errcode values are defined here:
        //   https://github.com/freedomjs/freedom/blob/master/interface/core.tcpsocket.json
        if (e.errcode === 'NOT_CONNECTED') {
          // This can happen if, for example, there was still data to be
          // read on the datachannel's queue when the socket closed.
          log.warn('%1: tried to send data on closed socket: %2', [
              this.longId(),
              e.errcode]);
        } else {
          log.error('%1: failed to send data on socket: %2', [
              this.longId(),
              e.errcode]);
        }
      });
    }

    // Configures forwarding of data from the TCP socket over the data channel
    // and vice versa. Should only be called once both socket and channel have
    // been successfully established.
    private linkSocketAndChannel_ = () : void => {
      var socketReadLoop = (data:ArrayBuffer) => {
        this.sendOnChannel_(data);
        Session.nextTick_(() => {
          this.tcpConnection_.dataFromSocketQueue.setSyncNextHandler(
              socketReadLoop);
        });
      }
      this.tcpConnection_.dataFromSocketQueue.setSyncNextHandler(
          socketReadLoop);

      var channelReadLoop = (data:WebRtc.Data) : void => {
        this.sendOnSocket_(data);
        Session.nextTick_(() => {
          this.dataChannel_.dataFromPeerQueue.setSyncNextHandler(
              channelReadLoop);
        });
      };
      this.dataChannel_.dataFromPeerQueue.setSyncNextHandler(
          channelReadLoop);
    }

    private isAllowedAddress_ = (addressString:string) : boolean => {
      // default is to disallow non-unicast addresses; i.e. only proxy for
      // public internet addresses.
      if (this.proxyConfig_.allowNonUnicast) {
        return true
      }

      // ipaddr.process automatically converts IPv4-mapped IPv6 addresses into
      // IPv4 Address objects.  This ensure that an attacker cannot reach a
      // restricted IPv4 endpoint that is identified by its IPv6-mapped address.
      try {
        var address = ipaddr.process(addressString);
        return address.range() == 'unicast';
      } catch (e) {
        // This likely indicates a malformed IP address, which will be logged by
        // the caller.
        return false;
      }
    }

    public getSnapshot = () : Promise<SessionSnapshot> => {
      return this.dataChannel_.getBufferedAmount().then((bufferedAmount:number) => {
        return {
          name: this.channelLabel(),
          channel: {
            sent: this.channelSentBytes_,
            received: this.channelReceivedBytes_,
            buffered: bufferedAmount,
            queue: {
              size: this.dataChannel_.dataFromPeerQueue.getLength(),
              handling: this.dataChannel_.dataFromPeerQueue.isHandling()
            }
          },
          socket: {
            sent: this.socketSentBytes_,
            received: this.socketReceivedBytes_,
            queue: {
              size: this.tcpConnection_.dataFromSocketQueue.getLength(),
              handling: this.tcpConnection_.dataFromSocketQueue.isHandling()
            }
          }
        };
      });
    }

    public longId = () : string => {
      var s = 'session ' + this.channelLabel();
      if (this.tcpConnection_) {
        s += ' (tcp-socket: ' + this.tcpConnection_.connectionId + ' ' +
            (this.tcpConnection_.isClosed() ? 'closed' : 'open') + ')';
      }
      return s;
    }

    // For logging/debugging.
    public toString = () : string => {
      var tcpString = 'undefined';
      if (this.tcpConnection_) {
        tcpString = this.tcpConnection_.toString();
      }
      return JSON.stringify({
        channelLabel_: this.channelLabel(),
        tcpConnection: tcpString
      });
    }

    // Runs callback once the current event loop has run to completion.
    // Uses setTimeout in lieu of something like Node's process.nextTick:
    //   https://github.com/uProxy/uproxy/issues/967
    private static nextTick_ = (callback:Function) : void => {
      setTimeout(callback, 0);
    }
  }  // Session

}  // module RtcToNet
export = RtcToNet;
