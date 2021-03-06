/// <reference path='../../../../third_party/freedom-typings/freedom-common.d.ts' />
/// <reference path='../../../../third_party/freedom-typings/freedom-module-env.d.ts' />

import AbstractProxyIntegrationTest = require('./proxy-integration-test');
import loggingTypes = require('../../../../third_party/uproxy-lib/loggingprovider/loggingprovider.types');

// Example of how to set custom logging level: we set everything to debug for
// testing echo server.
freedom['loggingcontroller']().setDefaultFilter(loggingTypes.Destination.console,
                                                loggingTypes.Level.debug);

if (typeof freedom !== 'undefined') {
  freedom().providePromises(AbstractProxyIntegrationTest);
}
