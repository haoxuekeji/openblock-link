const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, execFileSync} = require('child_process');

const Session = require('./session');

/**
 * Run standard Python programs on the local machine.
 *
 * Protocol (JSON-RPC 2.0 over the link websocket):
 *   client -> server methods:
 *     run   {code: string}   write code to a temp file and (re)start python
 *     stdin {data: string}   feed data to the running program's stdin
 *     stop  {}               kill the running program
 *     interpreter {}         returns the resolved python executable path
 *   server -> client notifications:
 *     stdout {data}          program standard output chunk
 *     stderr {data}          program standard error chunk
 *     started {pid}          program has started
 *     exit   {code, signal}  program finished or was killed
 */
class PythonRunnerSession extends Session {
    constructor (socket, userDataPath, toolsPath, request) {
        super(socket);
        this._type = 'python-runner';
        this.userDataPath = userDataPath;
        this.toolsPath = toolsPath;

        this._projectPath = path.join(userDataPath, 'pythonRunner');
        this._child = null;

        // Running arbitrary code is strictly a local-machine feature: refuse
        // websocket connections that do not originate from this host.
        const remote = request && request.socket && request.socket.remoteAddress;
        if (remote && !PythonRunnerSession.isLoopback(remote)) {
            console.warn(`python runner: rejected remote connection from ${remote}`);
            socket.close();
        }
    }

    static isLoopback (address) {
        return address === '127.0.0.1' ||
            address === '::1' ||
            address === '::ffff:127.0.0.1' ||
            address.startsWith('127.');
    }

    async didReceiveCall (method, params, completion) {
        switch (method) {
        case 'run':
            completion(await this.run(params), null);
            break;
        case 'stdin':
            completion(this.writeStdin(params), null);
            break;
        case 'stop':
            completion(this.stop(), null);
            break;
        case 'interpreter':
            completion(this.resolveInterpreter(), null);
            break;
        default:
            throw new Error(`Method not found`);
        }
    }

    /**
     * Find a usable python executable. Prefer the toolchain bundled with the
     * link tools (layout differs per platform, see upload/microPython.js),
     * fall back to the system interpreter so development setups without a
     * matching tools bundle still work.
     * @returns {string} path or command of the python executable
     */
    resolveInterpreter () {
        if (this._interpreter) {
            return this._interpreter;
        }
        const pythonDir = path.join(this.toolsPath, 'Python');
        let candidates;
        if (os.platform() === 'win32') {
            candidates = [path.join(pythonDir, 'python.exe'), path.join(pythonDir, 'python'), 'python'];
        } else if (os.platform() === 'darwin') {
            candidates = [path.join(pythonDir, 'python3'), 'python3'];
        } else {
            candidates = [path.join(pythonDir, 'bin/python3'), 'python3'];
        }
        for (const candidate of candidates) {
            try {
                if (path.isAbsolute(candidate)) {
                    fs.accessSync(candidate, fs.constants.X_OK);
                }
                // A wrong-platform bundle can carry exec bits but still not
                // run, so probe the binary for real before trusting it.
                execFileSync(candidate, ['--version'], {timeout: 10000, stdio: 'ignore'});
                this._interpreter = candidate;
                return candidate;
            } catch (e) {
                // try next candidate
            }
        }
        this._interpreter = os.platform() === 'win32' ? 'python' : 'python3';
        return this._interpreter;
    }

    async run (params) {
        const code = (params && params.code) || '';

        this.stop();

        await fs.promises.mkdir(this._projectPath, {recursive: true});
        const codeFile = path.join(this._projectPath, 'main.py');
        await fs.promises.writeFile(codeFile, code, 'utf8');

        const interpreter = this.resolveInterpreter();
        const child = spawn(interpreter, ['-u', codeFile], {
            cwd: this._projectPath,
            env: Object.assign({}, process.env, {
                PYTHONIOENCODING: 'utf-8',
                PYTHONUNBUFFERED: '1'
            }),
            // Own process group on posix so stop() can kill the whole tree.
            detached: os.platform() !== 'win32'
        });
        this._child = child;

        child.stdout.on('data', buf => {
            this.sendRemoteRequest('stdout', {data: buf.toString('utf8')});
        });
        child.stderr.on('data', buf => {
            this.sendRemoteRequest('stderr', {data: buf.toString('utf8')});
        });
        child.on('error', err => {
            if (this._child === child) {
                this._child = null;
            }
            this.sendRemoteRequest('exit', {pid: child.pid, code: null, signal: null, error: `${err.message}`});
        });
        child.on('exit', (exitCode, signal) => {
            if (this._child === child) {
                this._child = null;
            }
            this.sendRemoteRequest('exit', {pid: child.pid, code: exitCode, signal: signal});
        });

        this.sendRemoteRequest('started', {pid: child.pid});
        return {pid: child.pid, interpreter: interpreter};
    }

    writeStdin (params) {
        const data = (params && params.data) || '';
        if (this._child && this._child.stdin.writable) {
            this._child.stdin.write(data);
            return true;
        }
        return false;
    }

    stop () {
        const child = this._child;
        if (!child) {
            return false;
        }
        this._child = null;
        try {
            if (os.platform() === 'win32') {
                // Kill the whole tree; plain child.kill() leaves grandchildren.
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
            } else {
                process.kill(-child.pid, 'SIGKILL');
            }
        } catch (e) {
            try {
                child.kill('SIGKILL');
            } catch (e2) {
                // already gone
            }
        }
        return true;
    }

    dispose () {
        this.stop();
        super.dispose();
    }
}

module.exports = PythonRunnerSession;
