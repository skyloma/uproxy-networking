/// <reference path='../../../../third_party/typings/es6-promise/es6-promise.d.ts' />
/// <reference path='../../../../third_party/freedom-typings/pgp.d.ts' />
/// <reference path='../../../../third_party/freedom-typings/freedom-common.d.ts' />
/// <reference path='../../../../third_party/freedom-typings/freedom-module-env.d.ts' />

import arraybuffers = require('../../../../third_party/uproxy-lib/arraybuffers/arraybuffers');
import rtc_to_net = require('../../rtc-to-net/rtc-to-net');
import socks_to_rtc = require('../../socks-to-rtc/socks-to-rtc');
import net = require('../../net/net.types');
import signals = require('../../../../third_party/uproxy-lib/webrtc/signals');

import logging = require('../../../../third_party/uproxy-lib/logging/logging');
import loggingTypes = require('../../../../third_party/uproxy-lib/loggingprovider/loggingprovider.types');

// Set each module to info, warn, error, or debug depending on which module
// you're debugging. Since the proxy outputs quite a lot of messages, show only
// warnings by default from the rest of the system.  Note that the proxy is
// extremely slow in debug mode.
freedom['loggingcontroller']().setDefaultFilter(loggingTypes.Destination.console,
                                                loggingTypes.Level.info);
freedom['loggingcontroller']().setFilters(loggingTypes.Destination.console, {
  'SocksToRtc': loggingTypes.Level.info,
  'RtcToNet': loggingTypes.Level.info
});

var log :logging.Log = new logging.Log('copypaste-socks');

var pgp :PgpProvider = freedom['pgp']();
var friendKey :string;
// TODO interactive setup w/real passphrase
pgp.setup('', 'uProxy user <noreply@uproxy.org>');

var parentModule = freedom();

pgp.exportKey().then((publicKey:string) => {
  parentModule.emit('publicKeyExport', publicKey);
});

var pcConfig :freedom_RTCPeerConnection.RTCConfiguration = {
  iceServers: [{urls: ['stun:stun.l.google.com:19302']},
               {urls: ['stun:stun1.l.google.com:19302']}]
};

// These two modules together comprise a SOCKS server:
//  - socks-to-rtc is the frontend, which speaks the SOCKS protocol
//  - rtc-to-net creates sockets on behalf of socks-to-rtc
//
// The two modules communicate via a peer-to-peer connection.
//
// If we receive the 'start' signal from the UI then we create a
// socks-to-rtc module and this app will run the SOCKS frontend.
// If we receive signalling channel messages without having received
// the 'start' signal then we create an rtc-to-net instance and
// will act as the SOCKS backend.
var socksRtc:socks_to_rtc.SocksToRtc;
var rtcNet:rtc_to_net.RtcToNet;

parentModule.on('start', () => {
  var localhostEndpoint:net.Endpoint = { address: '127.0.0.1', port: 9999 };
  socksRtc = new socks_to_rtc.SocksToRtc();

  // Forward signalling channel messages to the UI.
  socksRtc.on('signalForPeer', (signal:any) => {
      parentModule.emit('signalForPeer', signal);
  });

  // SocksToRtc adds the number of bytes it sends/receives to its respective
  // queue as it proxies. When new numbers (of bytes) are added to these queues,
  // emit the number to the UI (look for corresponding freedom.on in main.html).
  socksRtc.on('bytesReceivedFromPeer', (numBytes:number) => {
      parentModule.emit('bytesReceived', numBytes);
  });

  socksRtc.on('bytesSentToPeer', (numBytes:number) => {
      parentModule.emit('bytesSent', numBytes);
  });

  socksRtc.on('stopped', () => {
    parentModule.emit('proxyingStopped');
  });

  socksRtc.startFromConfig(
      localhostEndpoint,
      pcConfig,
      false) // obfuscate
    .then((endpoint:net.Endpoint) => {
      log.info('socksRtc ready. listening to SOCKS5 on: ' + JSON.stringify(endpoint));
      log.info('` curl -x socks5h://localhost:9999 www.google.com `')
      parentModule.emit('proxyingStarted', endpoint);
    })
    .catch((e) => {
      console.error('socksRtc Error: ' + e + '; ' + this.socksRtc.toString());
    });
  log.info('created socks-to-rtc');
});

// Receive signalling channel messages from the UI.
// Messages are dispatched to either the socks-to-rtc or rtc-to-net
// modules depending on whether we're acting as the frontend or backend,
// respectively.
parentModule.on('handleSignalMessage', (message:signals.Message) => {
  if (socksRtc !== undefined) {
    socksRtc.handleSignalFromPeer(message);
  } else {
    if (rtcNet === undefined) {
      rtcNet = new rtc_to_net.RtcToNet();
      rtcNet.startFromConfig(
          { allowNonUnicast:true },
          pcConfig,
          false); // obfuscate
      log.info('created rtc-to-net');

      // Forward signalling channel messages to the UI.
      rtcNet.signalsForPeer.setSyncHandler((message:signals.Message) => {
          parentModule.emit('signalForPeer', message);
      });

      // Similarly to with SocksToRtc, emit the number of bytes sent/received
      // in RtcToNet to the UI.
      rtcNet.bytesReceivedFromPeer.setSyncHandler((numBytes:number) => {
          parentModule.emit('bytesReceived', numBytes);
      });

      rtcNet.bytesSentToPeer.setSyncHandler((numBytes:number) => {
          parentModule.emit('bytesSent', numBytes);
      });

      rtcNet.onceReady.then(() => {
        log.info('rtcNet ready.');
        parentModule.emit('proxyingStarted', null);
      });

      rtcNet.onceStopped.then(() => {
        parentModule.emit('proxyingStopped');
      });
    }
    rtcNet.handleSignalFromPeer(message);
  }
});

// Crypto request messages
parentModule.on('friendKey', (newFriendKey:string) => {
  friendKey = newFriendKey;
});

parentModule.on('signEncrypt', (message:string) => {
  pgp.signEncrypt(arraybuffers.stringToArrayBuffer(message), friendKey)
    .then((cipherdata:ArrayBuffer) => {
      return pgp.armor(cipherdata);
    })
    .then((ciphertext:string) => {
      parentModule.emit('ciphertext', ciphertext);
    });
});

parentModule.on('verifyDecrypt', (ciphertext:string) => {
  pgp.dearmor(ciphertext)
    .then((cipherdata:ArrayBuffer) => {
      return pgp.verifyDecrypt(cipherdata, friendKey);
    })
    .then((result:VerifyDecryptResult) => {
      parentModule.emit('verifyDecryptResult', result);
    });
});

// Stops proxying.
parentModule.on('stop', () => {
  if (socksRtc !== undefined) {
    socksRtc.stop();
  } else if (rtcNet !== undefined) {
    rtcNet.stop();
  }
});
