/// <reference path='../../../third_party/typings/es6-promise/es6-promise.d.ts' />

import peerconnection = require('../../../third_party/uproxy-lib/webrtc/peerconnection');
import datachannel = require('../../../third_party/uproxy-lib/webrtc/datachannel');
import handler = require('../../../third_party/uproxy-lib/handler/queue');
import queue = require('../../../third_party/uproxy-lib/queue/queue');

import logging = require('../../../third_party/uproxy-lib/logging/logging');

var log :logging.Log = new logging.Log('pool');

// This is the only exported class in this module.  It mimics the data channel
// aspects of the PeerConnection interface.  Internally, it provides a pool
// of channels that keeps old channels for reuse instead of closing them, and
// makes new channels as needed when the pool runs dry.
export class Pool {
  public peerOpenedChannelQueue
      :handler.QueueHandler<datachannel.DataChannel, void>;

  private localPool_ :LocalPool;

  constructor(
      pc:peerconnection.PeerConnection<any>,
      name_:string) {
    this.localPool_ = new LocalPool(pc, name_);
    var remotePool = new RemotePool(pc, name_);
    this.peerOpenedChannelQueue = remotePool.peerOpenedChannelQueue;
  }

  public openDataChannel = () : Promise<datachannel.DataChannel> => {
    return this.localPool_.openDataChannel();
  }
}

// Manages a pool of data channels opened by this peer.  The only public method
// is openDataChannel.
class LocalPool {
  private numChannels_ = 0;

  // Channels which have been closed, and may be re-opened.
  private pool_ = new queue.Queue<PoolChannel>();

  constructor(
      private pc_:peerconnection.PeerConnection<any>,
      private name_:string) {}

  public openDataChannel = () : Promise<PoolChannel> => {
    return this.reuseOrCreate_().then((channel:PoolChannel) => {
      return channel.open().then(() => {
        // When this channel closes, reset it and return it to the pool.
        channel.onceClosed.then(() => {
          this.onChannelClosed_(channel);
        });
        return channel;
      });
    });
  }

  private reuseOrCreate_ = () : Promise<PoolChannel> => {
    // If there are no channels available right now, open a new one.
    // TODO: limit the number of channels (probably should be <=256).
    if (this.pool_.length > 0) {
      var channel = this.pool_.shift();
      log.debug('%1: channel requested, pulled %2 from pool (%3 remaining)',
          this.name_, channel.getLabel(), this.pool_.length);
      return Promise.resolve(channel);
    } else {
      log.debug('%1: channel requested, creating new', this.name_);
      return this.openNewChannel_();
    }
  }

  // Creates and returns a new channel, wrapping it.
  private openNewChannel_ = () : Promise<PoolChannel> => {
    return this.pc_.openDataChannel('p' + this.numChannels_++).
        then((dc:datachannel.DataChannel) => {
          return dc.onceOpened.then(() => {
            return new PoolChannel(dc);
          });
        });
  }

  // Resets the channel, making it ready for use again, and adds it
  // to the pool.
  private onChannelClosed_ = (poolChannel:PoolChannel) : void => {
    poolChannel.reset();
    this.pool_.push(poolChannel);
    log.debug('%1: returned channel %2 to the pool (new size: %3)',
        this.name_, poolChannel.getLabel(), this.pool_.length);
  }
}

// Tracks a pool of channels that were opened by the remote peer.
class RemotePool {
  public peerOpenedChannelQueue = new handler.Queue<PoolChannel,void>();

  constructor(
      private pc_:peerconnection.PeerConnection<any>,
      private name_:string) {
    this.pc_.peerOpenedChannelQueue.setSyncHandler(this.onNewChannel_);
  }

  private onNewChannel_ = (dc:datachannel.DataChannel) => {
    log.debug('%1: remote side created new channel: %2',
        this.name_, dc.getLabel());
    dc.onceOpened.then(() => {
      var poolChannel = new PoolChannel(dc);
      this.listenForOpenAndClose_(poolChannel);
    });
  }

  private listenForOpenAndClose_ = (poolChannel:PoolChannel) : void => {
    poolChannel.onceOpened.then(() => {
      this.peerOpenedChannelQueue.handle(poolChannel);
    });
    poolChannel.onceClosed.then(() => {
      poolChannel.reset();
      this.listenForOpenAndClose_(poolChannel);
    });
  }
}

// These are the three control messages used.  To distinguish control
// messages from application data, all string messages are encapsulated
// in a JSON layer.  (Binary messages are unaffected.)
var OPEN = "open";
var CLOSE = "close";
var CLOSE_ACK = "close-ack";

// Each PoolChannel wraps an actual DataChannel, and provides behavior
// that is intended to be indistinguishable to the caller.  However,
// close() does not actually close the underlying channel.  Instead,
// it sends an in-band control message indicating the close, and the
// channel is returned to the pool of inactive channels, ready for
// reuse when the client asks for a new channel.
class PoolChannel implements datachannel.DataChannel {
  private fulfillOpened_ :() => void;
  public onceOpened : Promise<void>;

  private fulfillClosed_ :() => void;
  public onceClosed : Promise<void>;

  public dataFromPeerQueue :handler.Queue<datachannel.Data,void>;
  private lastDataFromPeerHandled_ : Promise<void>;

  private isOpen_ :boolean;
  private isClosing_ :boolean;  // True while waiting for CLOSE_ACK

  // dc_.onceOpened must already have resolved
  constructor(private dc_:datachannel.DataChannel) {
    this.reset();
    this.dc_.dataFromPeerQueue.setSyncHandler(this.onDataFromPeer_);
  }

  public reset = () => {
    this.dataFromPeerQueue = new handler.Queue<datachannel.Data,void>();
    this.lastDataFromPeerHandled_ = Promise.resolve<void>();
    this.onceOpened = new Promise<void>((F, R) => {
      this.fulfillOpened_ = F;
    });
    this.onceClosed = new Promise<void>((F, R) => {
      this.fulfillClosed_ = F;
    });

    this.isOpen_ = false;
    this.onceOpened.then(() => {
      this.isOpen_ = true;
    });
    this.onceClosed.then(() => {
      this.isOpen_ = false;
      this.isClosing_ = false;
    });
    this.isClosing_ = false;
  }

  public getLabel = () : string => {
    return this.dc_.getLabel();
  }

  public send = (data:datachannel.Data) : Promise<void> => {
    if (!this.isOpen_) {
      return Promise.reject(new Error('Can\'t send while closed'));
    }

    if (data.str) {
      return this.dc_.send({
        str: JSON.stringify({
          data: data.str
        })
      });
    }
    return this.dc_.send(data);
  }

  private sendControlMessage_ = (controlMessage:string) : Promise<void> => {
    log.debug('%1: sending control message: %2',
              this.getLabel(), controlMessage);
    return this.dc_.send({
      str: JSON.stringify({
        control: controlMessage
      })
    });
  }

  private onDataFromPeer_ = (data:datachannel.Data) : void => {
    if (data.str) {
      var msg = JSON.parse(data.str);
      if (typeof msg.data === 'string') {
        this.onDataForClient_({str: msg.data});
      } else if (typeof msg.control === 'string') {
        this.onControlMessage_(msg.control);
      } else {
        throw new Error('No data or control message found');
      }
      return;
    }
    this.onDataForClient_(data);
  }

  private onDataForClient_ = (data:datachannel.Data) : void => {
    this.lastDataFromPeerHandled_ = this.dataFromPeerQueue.handle(data);
  }

  private onControlMessage_ = (controlMessage:string) : void => {
    log.debug('%1: received control message: %2',
              this.getLabel(), controlMessage);
    if (controlMessage === OPEN) {
      if (this.isOpen_) {
        log.warn('%1: Got redundant open message', this.getLabel());
      }
      this.fulfillOpened_();
    } else if (controlMessage === CLOSE) {
      if (!this.isOpen_) {
        log.warn('%1: Got redundant close message', this.getLabel());
      }
      this.lastDataFromPeerHandled_.then(() => {
        return this.sendControlMessage_(CLOSE_ACK);
      }).then(this.fulfillClosed_);
    } else if (controlMessage === CLOSE_ACK) {
      if (!this.isClosing_) {
        log.warn('%1: Got unexpected CLOSE_ACK', this.getLabel());
        return;
      }
      this.fulfillClosed_();
    }
  }

  public getBrowserBufferedAmount = () : Promise<number> => {
    return this.dc_.getBrowserBufferedAmount();
  }

  public getJavascriptBufferedAmount = () : number => {
    return this.dc_.getJavascriptBufferedAmount();
  }

  public isInOverflow = () : boolean => {
    return this.dc_.isInOverflow();
  }

  public setOverflowListener = (listener:(overflow:boolean) => void) : void => {
    this.dc_.setOverflowListener(listener);
  }

  // New method for PoolChannel, not present in the DataChannel interface.
  public open = () : Promise<void> => {
    log.debug(this.getLabel() + ': open');
    if (this.isOpen_) {
      return Promise.reject(new Error('channel is already open'));
    }

    this.sendControlMessage_(OPEN);
    // Immediate open; there is no open-ack
    this.fulfillOpened_();

    return this.onceOpened;
  }

  public close = () : Promise<void> => {
    log.debug('%1: close', this.getLabel());
    if (!this.isOpen_) {
      return;
    }
    this.isClosing_ = true;

    this.sendControlMessage_(CLOSE);
    return this.onceClosed;
  }

  public toString = () : string => {
    return "PoolChannel wrapping " + this.dc_.toString();
  }
}