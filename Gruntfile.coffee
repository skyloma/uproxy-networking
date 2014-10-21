TaskManager = require 'uproxy-lib/tools/taskmanager'
Rule = require 'uproxy-lib/tools/common-grunt-rules'

path = require('path');

uproxyLibPath = path.dirname(require.resolve('uproxy-lib/package.json'))
ipaddrjsPath = path.dirname(require.resolve('ipaddr.js/package.json'))
churnPath = path.dirname(require.resolve('uproxy-churn/package.json'))
ccaPath = path.dirname(require.resolve('cca/package.json'))

FILES =
  # Help Jasmine's PhantomJS understand promises.
  jasmine_helpers: [
    'node_modules/es6-promise/dist/promise-*.js',
    '!node_modules/es6-promise/dist/promise-*amd.js',
    '!node_modules/es6-promise/dist/promise-*.min.js'
  ]

#-------------------------------------------------------------------------
module.exports = (grunt) ->
  grunt.initConfig {
    pkg: grunt.file.readJSON 'package.json'

    # TODO: Replace a common-grunt-rules function, when available.
    symlink:
      # Symlink each source file under src/ under build/.
      build:
        files: [
          expand: true
          cwd: 'src/'
          src: ['**/*']
          filter: 'isFile'
          dest: 'build/'
        ]

      # Symlink each file under uproxy-lib's dist/ under build/.
      # Exclude the samples/ directory.
      uproxyLibBuild:
        files: [
          expand: true
          cwd: path.join(uproxyLibPath, 'dist/')
          src: ['**/*', '!samples/**']
          filter: 'isFile'
          dest: 'build/'
        ]

      # Symlink each directory under uproxy-lib's third_party/ under build/third_party/.
      uproxyLibThirdParty:
        files: [
          expand: true
          cwd: path.join(uproxyLibPath, 'third_party/')
          src: ['*']
          filter: 'isDirectory'
          dest: 'build/third_party/'
        ]

      # Symlink each file under churn's dist/ under build/.
      # Exclude the samples/ directory.
      churnLib:
        files: [
          expand: true
          cwd: path.join(churnPath, 'dist/')
          src: ['**/*', '!samples/**']
          filter: 'isFile'
          dest: 'build/'
        ]

      # There's only one relevant file in this repo: ipaddr.min.js.
      ipaddrjs:
        files: [
          expand: true
          cwd: ipaddrjsPath
          src: ['ipaddr.min.js']
          dest: 'build/ipaddrjs/'
        ]

    copy:
      tcp: Rule.copyModule 'udp'
      udp: Rule.copyModule 'tcp'
      socksCommon: Rule.copyModule 'socks-common'
      socksToRtc: Rule.copyModule 'socks-to-rtc'
      ipaddrjs: Rule.copyModule 'ipaddrjs'
      rtcToNet: Rule.copyModule 'rtc-to-net'
      benchmark: Rule.copyModule 'benchmark'

      echoServerChromeApp: Rule.copyModule 'samples/echo-server-chromeapp'
      echoServerChromeAppLib: Rule.copySampleFiles 'samples/echo-server-chromeapp'

      simpleSocksChromeApp: Rule.copyModule 'samples/simple-socks-chromeapp'
      simpleSocksChromeAppLib: Rule.copySampleFiles 'samples/simple-socks-chromeapp'

      simpleSocksFirefoxApp: Rule.copyModule 'samples/simple-socks-firefoxapp'
      simpleSocksFirefoxAppLib: Rule.copySampleFiles 'samples/simple-socks-firefoxapp'

      copypasteSocksChromeApp: Rule.copyModule 'samples/copypaste-socks-chromeapp'
      copypasteSocksChromeAppLib: Rule.copySampleFiles 'samples/copypaste-socks-chromeapp'

    ts:
      tcp: Rule.typescriptSrc 'tcp'
      udp: Rule.typescriptSrc 'udp'

      socksCommon: Rule.typescriptSrc 'socks-common'
      socksCommonSpecDecl: Rule.typescriptSpecDecl 'socks-common'

      socksToRtc: Rule.typescriptSrc 'socks-to-rtc'
      socksToRtcSpecDecl: Rule.typescriptSpecDecl 'socks-to-rtc'

      rtcToNet: Rule.typescriptSrc 'rtc-to-net'
      # Benchmark
      benchmark: Rule.typescriptSrc 'benchmark'
      options: {
          module: 'commonjs',
          sourceMap: true,
          declaration: true
      }

      echoServerChromeApp: Rule.typescriptSrc 'samples/echo-server-chromeapp/'
      simpleSocksChromeApp: Rule.typescriptSrc 'samples/simple-socks-chromeapp'
      simpleSocksFirefoxApp: Rule.typescriptSrc 'samples/simple-socks-firefoxapp'
      copypasteSocksChromeApp: Rule.typescriptSrc 'samples/copypaste-socks-chromeapp'

    jasmine:
      socksCommon: Rule.jasmineSpec 'socks-common'

      # TODO: socksToRtc tests require a bunch of other modules
      #       https://github.com/uProxy/uproxy/issues/430
      socksToRtc:
        src: FILES.jasmine_helpers.concat([
          'build/handler/queue.js'
          'build/socks-to-rtc/mocks.js'
          'build/socks-to-rtc/socks-to-rtc.js'
        ])
        options:
          specs: 'build/socks-to-rtc/*.spec.js'

    clean: ['build/', 'dist/', '.tscache/']

    ccaJsPath: path.join(ccaPath, 'src/cca.js')
    ccaCwd: 'build/cca-app'
    exec: {
      adbLog: {
        command: 'adb logcat *:I | grep CONSOLE'
      }
      adbPortForward: {
        command: 'adb forward tcp:10000 tcp:9999'
        exitCode: [0,1]
      }
      ccaCreate: {
        command: '<%= ccaJsPath %> create build/cca-app --link-to=build/samples/simple-socks-chromeapp/manifest.json'
        exitCode: [0,1]
      }
      ccaEmulate: {
        cwd: '<%= ccaCwd %>'
        command: '<%= ccaJsPath %> emulate android'
      }
    }
  }  # grunt.initConfig

  #-------------------------------------------------------------------------
  grunt.loadNpmTasks 'grunt-contrib-clean'
  grunt.loadNpmTasks 'grunt-contrib-copy'
  grunt.loadNpmTasks 'grunt-contrib-jasmine'
  grunt.loadNpmTasks 'grunt-contrib-symlink'
  grunt.loadNpmTasks 'grunt-ts'

  #-------------------------------------------------------------------------
  # Define the tasks
  taskManager = new TaskManager.Manager();

  taskManager.add 'base', [
    'symlink:build'
    'symlink:uproxyLibBuild'
    'symlink:uproxyLibThirdParty'
    'symlink:churnLib'
  ]

  taskManager.add 'tcp', [
    'base'
    'ts:tcp'
    'copy:tcp'
  ]

  taskManager.add 'udp', [
    'base'
    'ts:udp'
    'copy:udp'
  ]

  taskManager.add 'socksCommon', [
    'base'
    'ts:socksCommon'
    'ts:socksCommonSpecDecl'
    'copy:socksCommon'
  ]

  taskManager.add 'socksToRtc', [
    'base'
    'tcp'
    'socksCommon'
    'ts:socksToRtc'
    'ts:socksToRtcSpecDecl'
    'copy:socksToRtc'
  ]

  taskManager.add 'ipaddrjs', [
    'base'
    'symlink:ipaddrjs'
    'copy:ipaddrjs'
  ]

  taskManager.add 'rtcToNet', [
    'base'
    'tcp'
    'socksCommon'
    'ipaddrjs'
    'ts:rtcToNet'
    'copy:rtcToNet'
  ]

  taskManager.add 'socks', [
    'socksCommon'
    'socksToRtc'
    'rtcToNet'
  ]

  taskManager.add 'echoServerChromeApp', [
    'base'
    'tcp'
    'ts:echoServerChromeApp'
    'copy:echoServerChromeApp'
    'copy:echoServerChromeAppLib'
  ]

  taskManager.add 'simpleSocksChromeApp', [
    'base'
    'socks'
    'ts:simpleSocksChromeApp'
    'copy:simpleSocksChromeApp'
    'copy:simpleSocksChromeAppLib'
  ]

  taskManager.add 'simpleSocksFirefoxApp', [
    'base'
    'socks'
    'ts:simpleSocksFirefoxApp'
    'copy:simpleSocksFirefoxApp'
    'copy:simpleSocksFirefoxAppLib'
  ]

  taskManager.add 'copypasteSocksChromeApp', [
    'base'
    'socks'
    'ts:copypasteSocksChromeApp'
    'copy:copypasteSocksChromeApp'
    'copy:copypasteSocksChromeAppLib'
  ]

  taskManager.add 'samples', [
    'echoServerChromeApp'
    'simpleSocksChromeApp'
    'simpleSocksFirefoxApp'
    'copypasteSocksChromeApp'
  ]

  #-------------------------------------------------------------------------
  # Tasks for Tools
  taskManager.add 'benchmark', [
    'base'
    'copy:benchmark'
    'ts:benchmark'
  ]

  #-------------------------------------------------------------------------
  taskManager.add 'build', [
    'tcp'
    'udp'
    'benchmark'
    'socks'
    'samples'
  ]

  taskManager.add 'test', [
    'build'
    'jasmine'
  ]

  taskManager.add 'default', [
    'build'
  ]

  taskManager.add 'cca', [
    'build'
    'exec:ccaCreate'
    'exec:ccaEmulate'
  ]

  #-------------------------------------------------------------------------
  # Register the tasks
  taskManager.list().forEach((taskName) =>
    grunt.registerTask taskName, (taskManager.get taskName)
  );
