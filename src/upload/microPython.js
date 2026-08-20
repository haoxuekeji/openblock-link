const fs = require('fs');
const {spawn} = require('child_process');
const path = require('path');
const ansi = require('ansi-string');
const os = require('os');

const ABORT_STATE_CHECK_INTERVAL = 100;

const OBMPY_BAUD = '115200';
const ESPTOOL_BAUD = '921600';
const FIRMWARE_SUFFIX = '.bin';

// Default chip parameters, overridable per device through config.chip /
// config.firmwarePrefix. The classic esp32 bootloader lives at 0x1000,
// newer chips (c3/s3/c6) are flashed from 0x0.
const DEFAULT_CHIP = 'esp32';
const CHIP_FLASH_ADDRESS = {
    esp32: '0x1000',
    esp32c3: '0x0',
    esp32s3: '0x0',
    esp32c6: '0x0'
};

// If obmpy put runs longer than this time, the board is considered to be
// stuck (e.g. no micropython firmware on it), kill it and treat it as failed.
const OBMPY_PUT_TIMEOUT = 30 * 1000;

// While a single put is in flight and the tool is quiet, emit a heartbeat so
// the upload UI does not look frozen on large files.
const OBMPY_PUT_HEARTBEAT_INTERVAL = 2 * 1000;

// How long to wait for the user to answer the "reflash firmware?" question.
// When it expires the flash is NOT performed, since it would erase every
// file stored on the board.
const FIRMWARE_CONFIRM_TIMEOUT = 5 * 60 * 1000;

// After flashing the firmware, wait for the board to boot for the first time
// and initialize its file system.
const FIRMWARE_BOOT_TIME = 10 * 1000;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class MicroPython {
    constructor (peripheralPath, config, userDataPath, toolsPath, sendstd, sendRemoteRequest) {
        this._peripheralPath = peripheralPath;
        this._config = config;
        this._userDataPath = userDataPath;
        this._projectPath = path.join(userDataPath, 'microPython/project');
        this._pythonPath = path.join(toolsPath, 'Python');
        this._firmwareDir = path.join(toolsPath, '../firmwares/microPython');
        this._sendstd = sendstd;
        this._sendRemoteRequest = sendRemoteRequest;

        this._abort = false;

        if (os.platform() === 'darwin') {
            this._pyPath = path.join(this._pythonPath, 'python3');
            this._obmpyPath = path.join(this._pythonPath, 'bin/obmpy');
            this._esptoolPath = path.join(this._pythonPath, 'bin/esptool.py');
        } else if (os.platform() === 'linux') {
            this._pyPath = path.join(this._pythonPath, 'bin/python3');
            this._obmpyPath = path.join(this._pythonPath, 'bin/obmpy');
            this._esptoolPath = path.join(this._pythonPath, 'bin/esptool.py');
        } else {
            this._pyPath = path.join(this._pythonPath, 'python');
            this._obmpyPath = path.join(this._pythonPath, 'Scripts/obmpy');
            this._esptoolPath = path.join(this._pythonPath, 'Scripts/esptool.py');
        }

        this._codefilePath = path.join(this._projectPath, 'main.py');

        this._chip = (config && config.chip) || DEFAULT_CHIP;
        this._flashAddress = (config && config.flashAddress) ||
            CHIP_FLASH_ADDRESS[this._chip] || '0x0';
        this._firmwarePrefix = (config && config.firmwarePrefix) || `${this._chip}-`;
    }

    abortUpload () {
        this._abort = true;
    }

    async flash (code) {
        const fileToPut = [];

        if (!fs.existsSync(this._projectPath)) {
            fs.mkdirSync(this._projectPath, {recursive: true});
        }

        try {
            fs.writeFileSync(this._codefilePath, code);
        } catch (err) {
            return Promise.reject(err);
        }

        fileToPut.push(this._codefilePath);

        this._config.library.forEach(lib => {
            if (fs.existsSync(lib)) {
                const libraries = fs.readdirSync(lib);
                libraries.forEach(file => {
                    if (file.endsWith('.py')) {
                        fileToPut.push(path.join(lib, file));
                    }
                });
            }
        });

        this._sendstd('Writing files...\n');

        let putExitCode = await this.putFiles(fileToPut);

        // Failed to put file means that the board has no micropython
        // firmware, or the firmware has been damaged. Flash the firmware
        // and then retry to put files once.
        if (putExitCode === 'Failed') {
            this._sendstd(`${ansi.yellow_dark}Could not enter raw REPL.\n`);
            this._sendstd(`${ansi.clear}The board may have no MicroPython firmware, or the firmware is damaged.\n`);
            this._sendstd(`${ansi.yellow_dark}Reflashing the firmware will erase all files stored on the board.\n`);
            this._sendstd(`${ansi.clear}Waiting for confirmation...\n`);

            const confirmed = await this.askFlashFirmwareConfirm();
            if (this._abort === true) {
                return Promise.resolve('Aborted');
            }
            if (!confirmed) {
                return Promise.reject(new Error('Firmware flashing was cancelled'));
            }

            this._sendstd(`${ansi.clear}Try to flash micropython for esp32 firmware to fix.\n`);

            const flashExitCode = await this.flashFirmware();
            if (flashExitCode === 'Aborted') {
                return Promise.resolve('Aborted');
            }

            this._sendstd('Waiting for the board to initialize the file system...\n');
            await wait(FIRMWARE_BOOT_TIME);

            if (this._abort === true) {
                return Promise.resolve('Aborted');
            }

            this._sendstd('Retry writing files...\n');
            putExitCode = await this.putFiles(fileToPut);
        }

        if (putExitCode === 'Aborted') {
            return Promise.resolve('Aborted');
        }

        if (putExitCode !== 'Success') {
            return Promise.reject(new Error('obmpy failed to write'));
        }

        this._sendstd(`${ansi.green_dark}Success\n`);
        return Promise.resolve('Success');
    }

    /**
     * Ask the client whether the MicroPython firmware may be reflashed,
     * which erases every file stored on the board. Falls back to NOT
     * flashing when there is no way to ask or no answer arrives in time.
     * @return {Promise<boolean>} - true when the user confirmed.
     */
    askFlashFirmwareConfirm () {
        if (typeof this._sendRemoteRequest !== 'function') {
            return Promise.resolve(false);
        }
        return new Promise(resolve => {
            let settled = false;
            let confirmTimeout = null;
            let abortWatcher = null;
            const finish = confirmed => {
                if (settled) return;
                settled = true;
                clearTimeout(confirmTimeout);
                clearInterval(abortWatcher);
                resolve(confirmed);
            };
            confirmTimeout = setTimeout(() => finish(false), FIRMWARE_CONFIRM_TIMEOUT);
            // React to the abort button while the question is pending.
            abortWatcher = setInterval(() => {
                if (this._abort) {
                    finish(false);
                }
            }, ABORT_STATE_CHECK_INTERVAL);
            try {
                this._sendRemoteRequest('uploadFirmwareConfirm', null, (result, error) => {
                    if (error) {
                        // Be conservative on transport errors, do not erase
                        // the board without an explicit confirmation.
                        return finish(false);
                    }
                    finish(Boolean(result && result.confirmed));
                });
            } catch (err) {
                finish(false);
            }
        });
    }

    async putFiles (files) {
        for (const file of files) {
            const putExitCode = await this.obmpyPut(file);
            if (putExitCode !== 'Success') {
                return putExitCode;
            }
            if (this._abort === true) {
                return 'Aborted';
            }
        }
        return 'Success';
    }

    obmpyPut (file) {
        return new Promise((resolve, reject) => {
            let fileSize = 0;
            try {
                fileSize = fs.statSync(file).size;
            } catch (err) {
                // Size is only used for progress text; missing stats are non-fatal.
                fileSize = 0;
            }
            const fileName = path.basename(file);
            const sizePart = fileSize > 0 ? ` (${fileSize} bytes)` : '';
            this._sendstd(`Writing ${fileName}${sizePart}...\n`);

            const obmpy = spawn(this._pyPath, [
                this._obmpyPath,
                '--port', this._peripheralPath,
                '--baud', OBMPY_BAUD,
                'put', file
            ]);

            let isTimeout = false;
            const startedAt = Date.now();
            let lastOutputAt = startedAt;
            const putTimeout = setTimeout(() => {
                isTimeout = true;
                obmpy.kill();
            }, OBMPY_PUT_TIMEOUT);

            const listenAbortSignal = setInterval(() => {
                if (this._abort) {
                    obmpy.kill();
                }
            }, ABORT_STATE_CHECK_INTERVAL);

            const heartbeat = setInterval(() => {
                const quietMs = Date.now() - lastOutputAt;
                if (quietMs < OBMPY_PUT_HEARTBEAT_INTERVAL) {
                    return;
                }
                const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
                const elapsedSizePart = fileSize > 0 ? `, ${fileSize} bytes` : '';
                this._sendstd(
                    `${ansi.yellow_dark}Still writing ${fileName}... ${elapsedSec}s elapsed${elapsedSizePart}\n`
                );
            }, OBMPY_PUT_HEARTBEAT_INTERVAL);

            const noteOutput = () => {
                lastOutputAt = Date.now();
            };

            obmpy.stdout.on('data', buf => {
                noteOutput();
                this._sendstd(buf.toString());
            });

            obmpy.stderr.on('data', buf => {
                noteOutput();
                this._sendstd(ansi.red + buf.toString());
            });

            const cleanup = () => {
                clearTimeout(putTimeout);
                clearInterval(listenAbortSignal);
                clearInterval(heartbeat);
            };

            obmpy.on('error', err => {
                cleanup();
                return reject(err);
            });

            obmpy.on('exit', outCode => {
                cleanup();
                if (this._abort === true) {
                    return resolve('Aborted');
                }
                if (isTimeout === true) {
                    this._sendstd(`${ansi.yellow_dark}Put ${file} timeout.\n`);
                    return resolve('Failed');
                }
                if (outCode === 0) {
                    this._sendstd(`${file} write finish\n`);
                    return resolve('Success');
                }
                return resolve('Failed');
            });
        });
    }

    async flashFirmware () {
        const firmwarePath = this.getFirmwarePath();
        if (firmwarePath === null) {
            return Promise.reject(new Error(`cannot find ${this._chip} micropython firmware`));
        }

        this._sendstd(`${ansi.green_dark}Start flash firmware...\n`);
        this._sendstd(`${ansi.clear}This step will take tens of seconds, please wait.\n`);
        this._sendstd(`Erasing flash and writing firmware ${path.basename(firmwarePath)}...\n`);

        // Erase + write in a single esptool invocation (write_flash --erase-all).
        // Two separate spawns need the chip to re-enter download mode between
        // them, which only happens on boards with an auto-reset (DTR/RTS)
        // circuit; boards entered download mode manually stay in the flasher
        // stub at the transfer baud rate and the second spawn can never sync.
        const writeExitCode = await this.runEsptool([
            '--chip', this._chip,
            '--port', this._peripheralPath,
            '--baud', ESPTOOL_BAUD,
            'write_flash', '--erase-all', '-z', this._flashAddress,
            firmwarePath
        ]);
        if (writeExitCode !== 'Success') {
            return Promise.resolve(writeExitCode);
        }

        this._sendstd(`${ansi.green_dark}Flash firmware Success.\n`);
        return Promise.resolve('Success');
    }

    /**
     * Run an obmpy subcommand and collect stdout text.
     * @param {Array.<string>} args - arguments after the shared port/baud flags.
     * @param {number} timeoutMs - kill timeout.
     * @return {Promise} resolved with {code, stdout, stderr}.
     * @private
     */
    _runObmpy (args, timeoutMs = OBMPY_PUT_TIMEOUT) {
        return new Promise((resolve, reject) => {
            const child = spawn(this._pyPath, [
                this._obmpyPath,
                '--port', this._peripheralPath,
                '--baud', OBMPY_BAUD
            ].concat(args));

            let stdout = '';
            let stderr = '';
            let isTimeout = false;
            const timer = setTimeout(() => {
                isTimeout = true;
                child.kill();
            }, timeoutMs);

            child.stdout.on('data', buf => {
                const text = buf.toString();
                stdout += text;
                this._sendstd(text);
            });
            child.stderr.on('data', buf => {
                const text = buf.toString();
                stderr += text;
                this._sendstd(ansi.red + text);
            });
            child.on('error', err => {
                clearTimeout(timer);
                reject(err);
            });
            child.on('exit', code => {
                clearTimeout(timer);
                if (isTimeout) {
                    reject(new Error(`obmpy ${args[0]} timeout`));
                    return;
                }
                resolve({code, stdout, stderr});
            });
        });
    }

    /**
     * List files on the board.
     * @param {string} directory - board directory.
     * @return {Promise} resolved with file entry array.
     */
    async listFiles (directory = '.') {
        const dir = directory && directory !== '.' ? String(directory) : '';
        const args = ['ls', '-l'];
        if (dir) args.push(dir);
        const {code, stdout, stderr} = await this._runObmpy(args);
        if (code !== 0) {
            throw new Error(stderr.trim() || `obmpy ls failed (${code})`);
        }
        return MicroPython.parseObmpyLs(stdout, dir || '.');
    }

    /**
     * Read a remote file and return base64 content.
     * @param {string} remotePath - board path.
     * @return {Promise} resolved with {name, path, size, contentBase64}.
     */
    async readFile (remotePath) {
        const remote = String(remotePath || '');
        const local = path.join(this._projectPath, `.board-get-${Date.now()}`);
        if (!fs.existsSync(this._projectPath)) {
            fs.mkdirSync(this._projectPath, {recursive: true});
        }
        try {
            const {code, stderr} = await this._runObmpy(['get', remote, local], 60 * 1000);
            if (code !== 0) {
                throw new Error(stderr.trim() || `obmpy get failed (${code})`);
            }
            const data = fs.readFileSync(local);
            return {
                name: path.basename(remote),
                path: remote,
                size: data.length,
                contentBase64: data.toString('base64')
            };
        } finally {
            try {
                fs.unlinkSync(local);
            } catch (e) {
                // ignore cleanup errors
            }
        }
    }

    /**
     * Remove a remote file or empty directory.
     * @param {string} remotePath - board path.
     * @return {Promise} resolved with true on success.
     */
    async removeFile (remotePath) {
        const remote = String(remotePath || '');
        const {code, stderr} = await this._runObmpy(['rm', remote]);
        if (code !== 0) {
            throw new Error(stderr.trim() || `obmpy rm failed (${code})`);
        }
        return true;
    }

    /**
     * Write base64 content to a remote file.
     * @param {string} remotePath - board path.
     * @param {string} contentBase64 - file bytes.
     * @return {Promise} resolved with true on success.
     */
    async writeFile (remotePath, contentBase64) {
        const remote = String(remotePath || '');
        const local = path.join(this._projectPath, `.board-put-${Date.now()}`);
        if (!fs.existsSync(this._projectPath)) {
            fs.mkdirSync(this._projectPath, {recursive: true});
        }
        fs.writeFileSync(local, Buffer.from(String(contentBase64 || ''), 'base64'));
        try {
            const {code, stderr} = await this._runObmpy(['put', local, remote], 60 * 1000);
            if (code !== 0) {
                throw new Error(stderr.trim() || `obmpy put failed (${code})`);
            }
            return true;
        } finally {
            try {
                fs.unlinkSync(local);
            } catch (e) {
                // ignore cleanup errors
            }
        }
    }

    /**
     * Parse `obmpy ls -l` stdout into structured entries.
     * Formats observed:
     *   123 main.py
     *   0 somedir/
     * @param {string} stdout - command output.
     * @param {string} directory - listed directory.
     * @return {Array} file entry objects.
     */
    static parseObmpyLs (stdout, directory = '.') {
        const dir = directory && directory !== '.' ? String(directory).replace(/\/$/, '') : '';
        const entries = [];
        const lines = String(stdout || '').split(/\r?\n/);
        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const match = trimmed.match(/^(\d+)\s+(.+)$/);
            if (!match) return;
            const size = Number(match[1]);
            let name = match[2].trim();
            const isDir = /\/$/.test(name);
            if (isDir) name = name.replace(/\/$/, '');
            if (!name) return;
            // obmpy may print absolute-ish paths; keep the leaf name for display
            // but preserve relative path when the listing already includes dirs.
            const parts = name.split('/').filter(Boolean);
            const leaf = parts.length ? parts[parts.length - 1] : name;
            const rel = name.indexOf('/') === -1 ? leaf : name;
            entries.push({
                name: leaf,
                path: dir ? `${dir}/${rel}` : rel,
                isDir,
                size: Number.isFinite(size) ? size : 0
            });
        });
        entries.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        return entries;
    }

    getFirmwarePath () {
        if (this._config.firmware) {
            if (path.isAbsolute(this._config.firmware)) {
                return this._config.firmware;
            }
            return path.join(this._firmwareDir, this._config.firmware);
        }

        if (!fs.existsSync(this._firmwareDir)) {
            return null;
        }

        const firmware = fs.readdirSync(this._firmwareDir)
            .find(file => file.startsWith(this._firmwarePrefix) && file.endsWith(FIRMWARE_SUFFIX));
        if (firmware) {
            return path.join(this._firmwareDir, firmware);
        }
        return null;
    }

    runEsptool (args) {
        return new Promise((resolve, reject) => {
            const esptool = spawn(this._pyPath, [this._esptoolPath].concat(args));

            const listenAbortSignal = setInterval(() => {
                if (this._abort) {
                    esptool.kill();
                }
            }, ABORT_STATE_CHECK_INTERVAL);

            esptool.stdout.on('data', buf => {
                this._sendstd(buf.toString());
            });

            esptool.stderr.on('data', buf => {
                this._sendstd(ansi.red + buf.toString());
            });

            esptool.on('error', err => {
                clearInterval(listenAbortSignal);
                return reject(err);
            });

            esptool.on('exit', outCode => {
                clearInterval(listenAbortSignal);
                switch (outCode) {
                case null:
                    // Process was killed by the abort signal.
                    return resolve('Aborted');
                case 0:
                    return resolve('Success');
                default:
                    return reject(new Error(`esptool exited with code ${outCode}`));
                }
            });
        });
    }
}

module.exports = MicroPython;
