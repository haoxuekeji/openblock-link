const {SerialPort} = require('serialport');
const ansi = require('ansi-string');

const Session = require('./session');
const Arduino = require('../upload/arduino');
const Microbit = require('../upload/microbit');
const MicroPython = require('../upload/microPython');
const usbId = require('../lib/usb-id');

const PERIPHERAL_UNPLUG_CHECK_INTERVAL = 100;

class SerialportSession extends Session {
    constructor (socket, userDataPath, toolsPath) {
        super(socket);

        this.userDataPath = userDataPath;
        this.toolsPath = toolsPath;

        this._type = 'serialport';
        this.peripheral = null;
        this.peripheralParams = null;
        this.reportedPeripherals = {};
        this.connectStateDetectorTimer = null;
        this.peripheralsScanorTimer = null;
        this.isRead = false;
        this.isInDisconnect = false;
        this.tool = null;
    }

    /**
     * The SerialPort implementation used by this session. Unit tests
     * inject a fake through SerialportSession.serialPortOverride so the
     * JSON-RPC protocol layer can be verified without real hardware.
     * @return {Function} - a SerialPort compatible class.
     */
    getSerialPortClass () {
        return SerialportSession.serialPortOverride || SerialPort;
    }

    async didReceiveCall (method, params, completion) {
        // The base session only catches synchronous throws; an exception
        // escaping this async handler would crash the whole link process
        // as an unhandled rejection and the client would wait forever for
        // a response, so report errors via the JSON-RPC response instead.
        try {
            switch (method) {
            case 'discover':
                this.discover(params);
                completion(null, null);
                break;
            case 'connect':
                await this.connect(params);
                completion(null, null);
                break;
            case 'disconnect':
                await this.disconnect();
                completion(null, null);
                break;
            case 'updateBaudrate':
                completion(await this.updateBaudrate(params), null);
                break;
            case 'write':
                completion(await this.write(params), null);
                break;
            case 'hardReset':
                completion(await this.hardReset(), null);
                break;
            case 'read':
                await this.read(params);
                completion(null, null);
                break;
            case 'upload':
                completion(await this.upload(params), null);
                break;
            case 'uploadFirmware':
                completion(await this.uploadFirmware(params), null);
                break;
            case 'abortUpload':
                completion(await this.abortUpload(), null);
                break;
            case 'listBoardFiles':
                completion(await this.listBoardFiles(params), null);
                break;
            case 'readBoardFile':
                completion(await this.readBoardFile(params), null);
                break;
            case 'removeBoardFile':
                completion(await this.removeBoardFile(params), null);
                break;
            case 'writeBoardFile':
                completion(await this.writeBoardFile(params), null);
                break;
            default:
                throw new Error(`Method not found`);
            }
        } catch (err) {
            completion(null, {message: `${(err && err.message) || err}`});
        }
    }

    discover (params) {
        if (this.peripheral && this.peripheral.isOpen === true) {
            throw new Error('cannot discover when connected');
        }
        const {filters} = params;
        if (!Array.isArray(filters.pnpid) || filters.pnpid.length < 1) {
            throw new Error('discovery request must include filters');
        }
        this.reportedPeripherals = {};
        this.getSerialPortClass().list()
            .then(peripheral => {
                this.onAdvertisementReceived(peripheral, filters);
            });
    }

    onAdvertisementReceived (peripheral, filters) {
        if (peripheral) {
            peripheral.forEach(device => {
                const vendorId = String(device.vendorId).toUpperCase();
                const productId = String(device.productId).toUpperCase();
                const pnpid = `USB\\VID_${vendorId}&PID_${productId}`;

                const name = usbId[pnpid] ? usbId[pnpid] : 'Unknown device';

                if (filters.pnpid.includes('*')) {
                    this.reportedPeripherals[device.path] = device;
                    this.sendRemoteRequest('didDiscoverPeripheral', {
                        peripheralId: device.path,
                        name: `${name} (${device.path})`
                    });
                } else if (filters.pnpid.includes(pnpid)) {
                    this.reportedPeripherals[device.path] = device;
                    this.sendRemoteRequest('didDiscoverPeripheral', {
                        peripheralId: device.path,
                        name: `${name} (${device.path})`
                    });
                }
            });
        }
    }

    connect (params, isConnectAfterUpload = false) {
        return new Promise((resolve, reject) => {
            if (this.peripheral && this.peripheral.isOpen === true) {
                return reject(new Error('already connected to peripheral'));
            }
            const {peripheralId, peripheralConfig} = params;

            const peripheral = this.reportedPeripherals[peripheralId];
            if (!peripheral) {
                return reject(new Error(`invalid peripheral ID: ${peripheralId}`));
            }
            if (this.peripheralsScanorTimer) {
                clearInterval(this.peripheralsScanorTimer);
                this.peripheralsScanorTimer = null;
            }
            const SerialPortClass = this.getSerialPortClass();
            const port = new SerialPortClass({
                path: peripheral.path,
                baudRate: peripheralConfig.config.baudRate,
                dataBits: peripheralConfig.config.dataBits,
                stopBits: peripheralConfig.config.stopBits,
                autoOpen: false
            });
            const rts = (typeof peripheralConfig.config.rts === 'undefined') ? true : peripheralConfig.config.rts;
            const dtr = (typeof peripheralConfig.config.dtr === 'undefined') ? true : peripheralConfig.config.dtr;

            try {
                port.open(openErr => {
                    if (openErr) {
                        if (isConnectAfterUpload === true) {
                            this.sendRemoteRequest('uploadError', {
                                message: ansi.red + openErr.message
                            });
                            this.sendRemoteRequest('peripheralUnplug', null);
                        }
                        if (openErr.message.includes('Access denied')) {
                            this.sendRemoteRequest('connectError', {message: 'Access denied'});
                        }
                        if (openErr.message.includes('Open (SetCommState): Unknown error code 31')) {
                            this.sendRemoteRequest('connectError', {message: 'Unknown error code 31'});
                        }
                        return reject(new Error(openErr));
                    }

                    port.set({rts: rts, dtr: dtr}, setErr => {
                        if (setErr) {
                            if (isConnectAfterUpload === true) {
                                this.sendRemoteRequest('peripheralUnplug', null);
                            }
                            return reject(new Error(setErr));
                        }

                        this.peripheral = port;
                        this.peripheralParams = params;

                        // Scan COM status prevent device pulled out
                        this.connectStateDetectorTimer = setInterval(() => {
                            if (this.peripheral.isOpen === false) {
                                clearInterval(this.connectStateDetectorTimer);
                                this.disconnect();
                                this.sendRemoteRequest('peripheralUnplug', null);
                            }
                        }, PERIPHERAL_UNPLUG_CHECK_INTERVAL);

                        // Only when the receiver function is set, can isopen detect that the device is pulled out
                        // A strange features of npm serialport package
                        port.on('data', rev => {
                            this.onMessageCallback(rev);
                        });

                        port.on('error', error => {
                            console.log('OpenBlock Link Error:', error);
                            this.disconnect();
                            this.sendRemoteRequest('peripheralUnplug', null);
                        });

                        resolve();
                    });
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    onMessageCallback (rev) {
        const params = {
            encoding: 'base64',
            message: rev.toString('base64')
        };
        if (this.isRead) {
            this.sendRemoteRequest('onMessage', params);
        }
    }

    updateBaudrate (params) {
        return new Promise((resolve, reject) => {
            if (this.isInDisconnect) {
                return resolve();
            }
            this.peripheralParams.peripheralConfig.config.baudRate = params.baudRate;
            this.peripheral.update(params, err => {
                if (err) {
                    return reject(new Error(`Error while attempting to update baudrate: ${err.message}`));
                }

                const rts = (typeof this.peripheralParams.peripheralConfig.config.rts === 'undefined') ?
                    true : this.peripheralParams.peripheralConfig.config.rts;
                const dtr = (typeof this.peripheralParams.peripheralConfig.config.dtr === 'undefined') ?
                    true : this.peripheralParams.peripheralConfig.config.dtr;

                // After update baudrate, the rts and dtr will be automatically modified,
                // we have to set them again.
                this.peripheral.set({rts: rts, dtr: dtr}, setErr => {
                    if (setErr) {
                        this.sendRemoteRequest('peripheralUnplug', null);
                        return reject(new Error(setErr));
                    }
                    return resolve();
                });
            });

        });
    }

    write (params) {
        return new Promise((resolve, reject) => {
            const {message, encoding} = params;
            const buffer = Buffer.from(message, encoding);

            if (this.isInDisconnect || !this.peripheral || this.peripheral.isOpen !== true) {
                // A write racing a teardown or an upload window (the port
                // is temporarily closed while a flash tool owns it) is
                // dropped on purpose; report 0 bytes written instead of an
                // error, which the client would treat as a lost connection.
                return resolve(0);
            }
            try {
                this.peripheral.write(buffer, 'binary', err => {
                    if (err) {
                        return reject(new Error(`Error while attempting to write: ${err.message}`));
                    }
                });
                // Respond only after the bytes left the OS buffer and report
                // the true byte count. The old code resolved immediately with
                // no value, which made the later drain resolve a no-op (the
                // client saw null before the data was actually flushed).
                this.peripheral.drain(err => {
                    if (err) {
                        return reject(new Error(`Error while attempting to write: ${err.message}`));
                    }
                    return resolve(buffer.length);
                });
            } catch (err) {
                return reject(err);
            }
        });
    }

    read () {
        this.isRead = true;
    }

    /**
     * Pulse the DTR/RTS control lines to trigger the reset circuit of a
     * typical dev board (esptool style: EN wired to RTS, IO0 to DTR),
     * then restore the configured line state.
     * @return {Promise} - resolved when the pulse is done.
     */
    hardReset () {
        return new Promise((resolve, reject) => {
            if (!this.peripheral || this.peripheral.isOpen !== true || this.isInDisconnect) {
                return resolve();
            }
            const config = this.peripheralParams.peripheralConfig.config;
            const rts = (typeof config.rts === 'undefined') ? true : config.rts;
            const dtr = (typeof config.dtr === 'undefined') ? true : config.dtr;

            this.peripheral.set({dtr: false, rts: true}, assertErr => {
                if (assertErr) {
                    return reject(new Error(assertErr));
                }
                setTimeout(() => {
                    this.peripheral.set({dtr: dtr, rts: rts}, restoreErr => {
                        if (restoreErr) {
                            return reject(new Error(restoreErr));
                        }
                        return resolve();
                    });
                }, 100);
            });
        });
    }

    disconnect () {
        this.isInDisconnect = true;
        return new Promise((resolve, reject) => {
            if (this.peripheral && this.peripheral.isOpen === true) {
                if (this.connectStateDetectorTimer) {
                    clearInterval(this.connectStateDetectorTimer);
                    this.connectStateDetectorTimer = null;
                }
                const peripheral = this.peripheral;
                try {
                    peripheral.pause();
                    // clear all cache data
                    peripheral.flush(() => {
                        peripheral.close(error => {
                            if (error) {
                                this.isInDisconnect = false;
                                return reject(Error(error));
                            }
                            this.isInDisconnect = false;
                            return resolve();
                        });
                    });
                } catch (err) {
                    this.isInDisconnect = false;
                    return reject(err);
                }
            } else {
                return resolve();
            }
        });
    }

    async upload (params) {
        const {message, config, encoding} = params;
        const code = Buffer.from(message, encoding).toString();

        const {baudRate} = this.peripheralParams.peripheralConfig.config;

        switch (config.type) {
        case 'arduino':
            this.tool = new Arduino(this.peripheral.path, config, this.userDataPath,
                this.toolsPath, this.sendstd.bind(this), this.sendRemoteRequest.bind(this));

            try {
                this.sendRemoteRequest('setUploadAbortEnabled', true);
                const exitCode = await this.tool.build(code);
                if (exitCode === 'Success') {
                    try {
                        this.sendstd(`${ansi.clear}Disconnect serial port\n`);
                        await this.disconnect();
                        this.sendstd(`${ansi.clear}Disconnected successfully, flash program starting...\n`);
                        const flashExitCode = await this.tool.flash();
                        await this.connect(this.peripheralParams, true);
                        this.sendRemoteRequest('uploadSuccess', {aborted: flashExitCode === 'Aborted'});
                    } catch (err) {
                        this.sendRemoteRequest('uploadError', {
                            message: ansi.red + err.message
                        });
                        // if error in flash step. It is considered that the device has been removed.
                        this.sendRemoteRequest('peripheralUnplug', null);
                    }
                } else if (exitCode === 'Aborted') {
                    this.sendRemoteRequest('uploadSuccess', {aborted: true});
                }
            } catch (err) {
                this.sendRemoteRequest('uploadError', {
                    message: ansi.red + err.message
                });
            }
            break;
        case 'microbit':
            this.tool = new Microbit(this.peripheral.path, config, this.userDataPath,
                this.toolsPath, this.sendstd.bind(this), this.sendRemoteRequest.bind(this));
            try {
                this.sendRemoteRequest('setUploadAbortEnabled', true);
                await this.disconnect();
                const exitCode = await this.tool.flash(code);
                await this.connect(this.peripheralParams, true);
                await this.updateBaudrate({baudRate: 115200});
                this.sendstd(`${ansi.clear}Reset device\n`);
                await this.write({message: '04', encoding: 'hex'});
                await this.updateBaudrate({baudRate: baudRate});

                this.sendRemoteRequest('uploadSuccess', {aborted: exitCode === 'Aborted'});
            } catch (err) {
                this.sendRemoteRequest('uploadError', {
                    message: ansi.red + err.message
                });
                this.sendRemoteRequest('peripheralUnplug', null);
            }
            break;
        case 'microPython':
            this.tool = new MicroPython(this.peripheral.path, config, this.userDataPath,
                this.toolsPath, this.sendstd.bind(this), this.sendRemoteRequest.bind(this));
            try {
                this.sendRemoteRequest('setUploadAbortEnabled', true);
                this.sendstd(`${ansi.clear}Disconnect serial port\n`);
                await this.disconnect();
                this.sendstd(`${ansi.clear}Disconnected successfully, uploading program starting...\n`);
                const exitCode = await this.tool.flash(code);
                await this.connect(this.peripheralParams, true);
                await this.updateBaudrate({baudRate: 115200});
                this.sendstd(`${ansi.clear}Reset device\n`);
                await this.write({message: '04', encoding: 'hex'});
                await this.updateBaudrate({baudRate: baudRate});

                this.sendRemoteRequest('uploadSuccess', {aborted: exitCode === 'Aborted'});
            } catch (err) {
                this.sendRemoteRequest('uploadError', {
                    message: ansi.red + err.message
                });
                this.sendRemoteRequest('peripheralUnplug', null);
            }
            break;
        }

        this.tool = null;
    }

    async uploadFirmware (params) {
        switch (params.type) {
        case 'arduino':
            this.tool = new Arduino(this.peripheral.path, params, this.userDataPath,
                this.toolsPath, this.sendstd.bind(this));
            try {
                this.sendRemoteRequest('setUploadAbortEnabled', true);
                this.sendstd(`${ansi.clear}Disconnect serial port\n`);
                await this.disconnect();
                this.sendstd(`${ansi.clear}Disconnected successfully, flash program starting...\n`);
                const flashExitCode = await this.tool.flashRealtimeFirmware();
                await this.connect(this.peripheralParams, true);
                this.sendRemoteRequest('uploadSuccess', {aborted: flashExitCode === 'Aborted'});
            } catch (err) {
                this.sendRemoteRequest('uploadError', {
                    message: ansi.red + err.message
                });
            }
            break;
        case 'microPython':
            this.tool = new MicroPython(this.peripheral.path, params, this.userDataPath,
                this.toolsPath, this.sendstd.bind(this), this.sendRemoteRequest.bind(this));
            try {
                this.sendRemoteRequest('setUploadAbortEnabled', true);
                this.sendstd(`${ansi.clear}Disconnect serial port\n`);
                await this.disconnect();
                this.sendstd(`${ansi.clear}Disconnected successfully, flash firmware starting...\n`);
                const flashExitCode = await this.tool.flashFirmware();
                await this.connect(this.peripheralParams, true);
                this.sendRemoteRequest('uploadSuccess', {aborted: flashExitCode === 'Aborted'});
            } catch (err) {
                this.sendRemoteRequest('uploadError', {
                    message: ansi.red + err.message
                });
            }
            break;
        }

        this.tool = null;
    }

    async abortUpload () {
        if (this.tool !== null) {
            this.tool.abortUpload();
        }
    }

    /**
     * Run a MicroPython board-filesystem helper while temporarily releasing
     * the serial port (obmpy needs exclusive access).
     * @param {object} params - request params including config.
     * @param {Function} runner - async (tool) => result.
     * @return {Promise} resolved with the runner result.
     * @private
     */
    async _withMicroPythonTool (params, runner) {
        if (!this.peripheral || !this.peripheral.path) {
            throw new Error('No peripheral is connected');
        }
        const config = (params && params.config) || {type: 'microPython'};
        const tool = new MicroPython(
            this.peripheral.path,
            config,
            this.userDataPath,
            this.toolsPath,
            this.sendstd.bind(this),
            this.sendRemoteRequest.bind(this)
        );
        const reconnectParams = this.peripheralParams;
        await this.disconnect();
        try {
            return await runner(tool);
        } finally {
            if (reconnectParams) {
                await this.connect(reconnectParams, true);
            }
        }
    }

    async listBoardFiles (params) {
        return this._withMicroPythonTool(params, tool =>
            tool.listFiles(params && params.directory));
    }

    async readBoardFile (params) {
        return this._withMicroPythonTool(params, tool =>
            tool.readFile(params && params.path));
    }

    async removeBoardFile (params) {
        return this._withMicroPythonTool(params, tool =>
            tool.removeFile(params && params.path));
    }

    async writeBoardFile (params) {
        return this._withMicroPythonTool(params, tool =>
            tool.writeFile(params && params.path, params && params.contentBase64));
    }

    sendstd (message) {
        if (this._socket) {
            this.sendRemoteRequest('uploadStdout', {
                message: message
            });
        }
    }

    dispose () {
        this.disconnect();

        super.dispose();
        this.peripheral = null;
        this.peripheralParams = null;
        this.reportedPeripherals = {};
        if (this.connectStateDetectorTimer) {
            clearInterval(this.connectStateDetectorTimer);
            this.connectStateDetectorTimer = null;
        }
        if (this.peripheralsScanorTimer) {
            
            clearInterval(this.peripheralsScanorTimer);
            this.peripheralsScanorTimer = null;
        }
    }
}

/**
 * Test hook: unit tests inject a fake SerialPort implementation so the
 * JSON-RPC protocol layer can be verified on machines without hardware.
 * @type {?Function}
 */
SerialportSession.serialPortOverride = null;

module.exports = SerialportSession;
