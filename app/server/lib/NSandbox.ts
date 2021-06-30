/**
 * JS controller for the pypy sandbox.
 */
import * as pidusage from '@gristlabs/pidusage';
import * as marshal from 'app/common/marshal';
import {ISandbox, ISandboxCreationOptions, ISandboxCreator} from 'app/server/lib/ISandbox';
import * as log from 'app/server/lib/log';
import * as sandboxUtil from 'app/server/lib/sandboxUtil';
import * as shutdown from 'app/server/lib/shutdown';
import {Throttle} from 'app/server/lib/Throttle';
import {ChildProcess, spawn, SpawnOptions} from 'child_process';
import * as path from 'path';
import {Stream, Writable} from 'stream';
import * as _ from 'lodash';
import * as fs from "fs";

type SandboxMethod = (...args: any[]) => any;

export interface ISandboxOptions {
  args: string[];         // The arguments to pass to the python process.
  exports?: {[name: string]: SandboxMethod}; // Functions made available to the sandboxed process.
  logCalls?: boolean;     // (Not implemented) Whether to log all system calls from the python sandbox.
  logTimes?: boolean;     // Whether to log time taken by calls to python sandbox.
  unsilenceLog?: boolean; // Don't silence the sel_ldr logging.
  selLdrArgs?: string[];  // Arguments passed to selLdr, for instance the following sets an
                          // environment variable `{ ... selLdrArgs: ['-E', 'PYTHONPATH=grist'] ... }`.
  logMeta?: log.ILogMeta; // Log metadata (e.g. including docId) to report in all log messages.
  command?: string;
  env?: NodeJS.ProcessEnv;
}

type ResolveRejectPair = [(value?: any) => void, (reason?: unknown) => void];

// Type for basic message identifiers, available as constants in sandboxUtil.
type MsgCode = null | true | false;

// Optional root folder to store binary data sent to and from the sandbox
// See test_replay.py
const recordBuffersRoot = process.env.RECORD_SANDBOX_BUFFERS_DIR;

export class NSandbox implements ISandbox {
  /**
   * Helper function to run the nacl sandbox. It takes care of most arguments, similarly to
   * nacl/bin/run script, but without the reliance on bash. We can't use bash when -r/-w options
   * because on Windows it doesn't pass along the open file descriptors. Bash is also unavailable
   * when installing a standalone version on Windows.
   */
  public static spawn(options: ISandboxOptions): ChildProcess {
    const {command, args: pythonArgs, unsilenceLog, env} = options;
    const spawnOptions: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env,
    };
    if (command) {
      return spawn(command, pythonArgs,
                   {cwd: path.join(process.cwd(), 'sandbox'), ...spawnOptions});
    }

    const noLog = unsilenceLog ? [] :
      (process.env.OS === 'Windows_NT' ? ['-l', 'NUL'] : ['-l', '/dev/null']);
    // We use these options to set up communication with the sandbox:
    // -r 3:3  to associate a file descriptor 3 on the outside of the sandbox with FD 3 on the
    //         inside, for reading from the inside. This becomes `this._streamToSandbox`.
    // -w 4:4  to associate FD 4 on the outside with FD 4 on the inside for writing from the inside.
    //         This becomes `this._streamFromSandbox`
    const selLdrArgs = ['-r', '3:3', '-w', '4:4', ...options.selLdrArgs || []];
    for (const [key, value] of _.toPairs(env)) {
      selLdrArgs.push("-E");
      selLdrArgs.push(`${key}=${value}`);
    }
    return spawn('sandbox/nacl/bin/sel_ldr', [
        '-B', './sandbox/nacl/lib/irt_core.nexe', '-m', './sandbox/nacl/root:/:ro',
        ...noLog,
        ...selLdrArgs,
        './sandbox/nacl/lib/runnable-ld.so',
        '--library-path', '/slib', '/python/bin/python2.7.nexe',
        ...pythonArgs
      ],
      spawnOptions,
    );
  }

  public readonly childProc: ChildProcess;
  private _logTimes: boolean;
  private _exportedFunctions: {[name: string]: SandboxMethod};
  private _marshaller = new marshal.Marshaller({stringToBuffer: false, version: 2});
  private _unmarshaller = new marshal.Unmarshaller({ bufferToString: false });

  // Members used for reading from the sandbox process.
  private _pendingReads: ResolveRejectPair[] = [];
  private _isReadClosed = false;
  private _isWriteClosed = false;

  private _logMeta: log.ILogMeta;
  private _streamToSandbox: Writable;
  private _streamFromSandbox: Stream;

  private _throttle: Throttle | undefined;

  // Create a unique subdirectory for each sandbox process so they can be replayed separately
  private _recordBuffersDir = recordBuffersRoot ? path.resolve(recordBuffersRoot, new Date().toISOString()) : null;

  /*
   * Callers may listen to events from sandbox.childProc (a ChildProcess), e.g. 'close' and 'error'.
   * The sandbox listens for 'aboutToExit' event on the process, to properly shut down.
   */
  constructor(options: ISandboxOptions) {
    this._logTimes = Boolean(options.logTimes || options.logCalls);
    this._exportedFunctions = options.exports || {};

    this.childProc = NSandbox.spawn(options);

    this._logMeta = {sandboxPid: this.childProc.pid, ...options.logMeta};
    log.rawDebug("Sandbox started", this._logMeta);

    this._streamToSandbox = (this.childProc.stdio as Stream[])[3] as Writable;
    this._streamFromSandbox = (this.childProc.stdio as Stream[])[4];

    this.childProc.on('close', this._onExit.bind(this));
    this.childProc.on('error', this._onError.bind(this));

    this.childProc.stdout.on('data', sandboxUtil.makeLinePrefixer('Sandbox stdout: ', this._logMeta));
    this.childProc.stderr.on('data', sandboxUtil.makeLinePrefixer('Sandbox stderr: ', this._logMeta));

    this._streamFromSandbox.on('data', (data) => this._onSandboxData(data));
    this._streamFromSandbox.on('end', () => this._onSandboxClose());
    this._streamFromSandbox.on('error', (err) => {
      log.rawError(`Sandbox error reading: ${err}`, this._logMeta);
      this._onSandboxClose();
    });

    this._streamToSandbox.on('error', (err) => {
      if (!this._isWriteClosed) {
        log.rawError(`Sandbox error writing: ${err}`, this._logMeta);
      }
    });

    // On shutdown, shutdown the child process cleanly, and wait for it to exit.
    shutdown.addCleanupHandler(this, this.shutdown);

    if (process.env.GRIST_THROTTLE_CPU) {
      this._throttle = new Throttle({
        pid: this.childProc.pid,
        logMeta: this._logMeta,
      });
    }

    if (this._recordBuffersDir) {
      log.rawDebug(`Recording sandbox buffers in ${this._recordBuffersDir}`, this._logMeta);
      fs.mkdirSync(this._recordBuffersDir, {recursive: true});
    }
  }

  /**
   * Shuts down the sandbox process cleanly, and wait for it to exit.
   * @return {Promise} Promise that's resolved with [code, signal] when the sandbox exits.
   */
  public async shutdown() {
    log.rawDebug("Sandbox shutdown starting", this._logMeta);
    shutdown.removeCleanupHandlers(this);

    // The signal ensures the sandbox process exits even if it's hanging in an infinite loop or
    // long computation. It doesn't get a chance to clean up, but since it is sandboxed, there is
    // nothing it needs to clean up anyway.
    const timeoutID = setTimeout(() => {
      log.rawWarn("Sandbox sending SIGKILL", this._logMeta);
      this.childProc.kill('SIGKILL');
    }, 1000);

    const result = await new Promise((resolve, reject) => {
      if (this._isWriteClosed) { resolve(); }
      this.childProc.on('error', reject);
      this.childProc.on('close', resolve);
      this.childProc.on('exit', resolve);
      this._close();
    });

    // In the normal case, the kill timer is pending when the process exits, and we can clear it. If
    // the process got killed, the timer is invalid, and clearTimeout() does nothing.
    clearTimeout(timeoutID);
    return result;
  }

  /**
   * Makes a call to the python process implementing our calling convention on stdin/stdout.
   * @param funcName The name of the python RPC function to call.
   * @param args Arguments to pass to the given function.
   * @returns A promise for the return value from the Python function.
   */
  public pyCall(funcName: string, ...varArgs: unknown[]): Promise<any> {
    const startTime = Date.now();
    this._sendData(sandboxUtil.CALL, Array.from(arguments));
    return this._pyCallWait(funcName, startTime);
  }

  /**
   * Returns the RSS (resident set size) of the sandbox process, in bytes.
   */
  public async reportMemoryUsage() {
    const memory = (await pidusage(this.childProc.pid)).memory;
    log.rawDebug('Sandbox memory', {memory, ...this._logMeta});
  }

  private async _pyCallWait(funcName: string, startTime: number): Promise<any> {
    try {
      return await new Promise((resolve, reject) => {
        this._pendingReads.push([resolve, reject]);
      });
    } finally {
      if (this._logTimes) {
        log.rawDebug(`Sandbox pyCall[${funcName}] took ${Date.now() - startTime} ms`, this._logMeta);
      }
    }
  }


  private _close() {
    if (this._throttle) { this._throttle.stop(); }
    if (!this._isWriteClosed) {
      // Close the pipe to the sandbox, which should cause the sandbox to exit cleanly.
      this._streamToSandbox.end();
      this._isWriteClosed = true;
    }
  }

  private _onExit(code: number, signal: string) {
    this._close();
    log.rawDebug(`Sandbox exited with code ${code} signal ${signal}`, this._logMeta);
  }


  private _onError(err: Error) {
    this._close();
    log.rawWarn(`Sandbox could not be spawned: ${err}`, this._logMeta);
  }


  /**
   * Send a message to the sandbox process with the given message code and data.
   */
  private _sendData(msgCode: MsgCode, data: any) {
    if (this._isReadClosed) {
      throw new sandboxUtil.SandboxError("PipeToSandbox is closed");
    }
    this._marshaller.marshal(msgCode);
    this._marshaller.marshal(data);
    const buf = this._marshaller.dumpAsBuffer();
    if (this._recordBuffersDir) {
      fs.appendFileSync(path.resolve(this._recordBuffersDir, "input"), buf);
    }
    return this._streamToSandbox.write(buf);
  }


  /**
   * Process a buffer of data received from the sandbox process.
   */
  private _onSandboxData(data: any) {
    this._unmarshaller.parse(data, buf => {
      const value = marshal.loads(buf, { bufferToString: true });
      if (this._recordBuffersDir) {
        fs.appendFileSync(path.resolve(this._recordBuffersDir, "output"), buf);
      }
      this._onSandboxMsg(value[0], value[1]);
    });
  }


  /**
   * Process the closing of the pipe by the sandboxed process.
   */
  private _onSandboxClose() {
    if (this._throttle) { this._throttle.stop(); }
    this._isReadClosed = true;
    // Clear out all reads pending on PipeFromSandbox, rejecting them with the given error.
    const err = new sandboxUtil.SandboxError("PipeFromSandbox is closed");
    this._pendingReads.forEach(resolvePair => resolvePair[1](err));
    this._pendingReads = [];
  }


  /**
   * Process a parsed message from the sandboxed process.
   */
  private _onSandboxMsg(msgCode: MsgCode, data: any) {
    if (msgCode === sandboxUtil.CALL) {
      // Handle calls FROM the sandbox.
      if (!Array.isArray(data) || data.length === 0) {
        log.rawWarn("Sandbox invalid call from the sandbox", this._logMeta);
      } else {
        const fname = data[0];
        const args = data.slice(1);
        log.rawDebug(`Sandbox got call to ${fname} (${args.length} args)`, this._logMeta);
        Promise.resolve()
        .then(() => {
          const func = this._exportedFunctions[fname];
          if (!func) { throw new Error("No such exported function: " + fname); }
          return func(...args);
        })
        .then((ret) => {
          this._sendData(sandboxUtil.DATA, ret);
        }, (err) => {
          this._sendData(sandboxUtil.EXC, err.toString());
        })
        .catch((err) => {
          log.rawDebug(`Sandbox sending response failed: ${err}`, this._logMeta);
        });
      }
    } else {
      // Handle return values for calls made to the sandbox.
      const resolvePair = this._pendingReads.shift();
      if (resolvePair) {
        if (msgCode === sandboxUtil.EXC) {
          resolvePair[1](new sandboxUtil.SandboxError(data));
        } else if (msgCode === sandboxUtil.DATA) {
          resolvePair[0](data);
        } else {
          log.rawWarn("Sandbox invalid message from sandbox", this._logMeta);
        }
      }
    }
  }
}

export class NSandboxCreator implements ISandboxCreator {
  public constructor(private _flavor: 'pynbox' | 'unsandboxed') {
  }

  public create(options: ISandboxCreationOptions): ISandbox {
    const pynbox = this._flavor === 'pynbox';
    // Main script to run.
    const defaultEntryPoint = pynbox ? 'grist/main.pyc' : 'grist/main.py';
    const args = [options.entryPoint || defaultEntryPoint];
    if (!options.entryPoint && options.comment) {
      // When using default entry point, we can add on a comment as an argument - it isn't
      // used, but will show up in `ps` output for the sandbox process.  Comment is intended
      // to be a document name/id.
      args.push(options.comment);
    }
    const selLdrArgs: string[] = [];
    if (options.sandboxMount) {
      selLdrArgs.push(
        // TODO: Only modules that we share with plugins should be mounted. They could be gathered in
        // a "$APPROOT/sandbox/plugin" folder, only which get mounted.
        '-m', `${options.sandboxMount}:/sandbox:ro`);
    }
    if (options.importMount) {
      selLdrArgs.push('-m', `${options.importMount}:/importdir:ro`);
    }
    const pythonVersion = 'python2.7';
    const env: NodeJS.ProcessEnv = {
      // Python library path is only configurable when flavor is unsandboxed.
      // In this case, expect to find library files in a virtualenv built by core
      // buildtools/prepare_python.sh
      PYTHONPATH: pynbox ? 'grist:thirdparty' :
        path.join(process.cwd(), 'sandbox', 'grist') + ':' +
        path.join(process.cwd(), 'venv', 'lib', pythonVersion, 'site-packages'),

      DOC_URL: (options.docUrl || '').replace(/[^-a-zA-Z0-9_:/?&.]/, ''),

      // Making time and randomness act deterministically for testing purposes.
      // See test/utils/recordPyCalls.ts
      ...(process.env.LIBFAKETIME_PATH ? {  // path to compiled binary
        DETERMINISTIC_MODE: '1',  // tells python to seed the random module
        FAKETIME: "2020-01-01 00:00:00",  // setting for libfaketime

        // For Linux
        LD_PRELOAD: process.env.LIBFAKETIME_PATH,

        // For Mac (https://github.com/wolfcw/libfaketime/blob/master/README.OSX)
        DYLD_INSERT_LIBRARIES: process.env.LIBFAKETIME_PATH,
        DYLD_FORCE_FLAT_NAMESPACE: '1',
      } : {}),
    };
    return new NSandbox({
      args,
      logCalls: options.logCalls,
      logMeta: options.logMeta,
      logTimes: options.logTimes,
      selLdrArgs,
      env,
      ...(pynbox ? {} : {command: pythonVersion}),
    });
  }
}
