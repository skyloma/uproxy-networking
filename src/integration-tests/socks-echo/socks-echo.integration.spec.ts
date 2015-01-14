/// <reference path='../../freedom/typings/freedom.d.ts' />
/// <reference path='../../third_party/typings/jasmine/jasmine.d.ts' />

// Integration test for the whole proxying system.
// The real work is done in the Freedom module which starts an echo test
// when we call "run".
describe('proxy integration tests', function() {
  var testModule :any;

  var str2ab = (s:string) : ArrayBuffer => {
    var byteArray = new Uint8Array(s.length);
    for (var i = 0; i < s.length; ++i) {
      byteArray[i] = s.charCodeAt(i);
    }
    return byteArray.buffer;
  };

  beforeEach(function(done) {
    freedom('scripts/build/integration-tests/socks-echo/integration.json',
            { 'debug': 'log' })
        .then((interface:any) => {
          testModule = interface();
          done();
        });
  });

  it('run a simple echo test', (done) => {
    var input = str2ab('arbitrary test string');
    testModule.singleEchoTest(input).then((output:ArrayBuffer) => {
      expect(new Uint8Array(output)).toEqual(new Uint8Array(input));
    }).catch((e:any) => {
      expect(e).toBeUndefined();
    }).then(done);
  });
});
