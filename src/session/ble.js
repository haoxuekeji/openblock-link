const Session = require('./session');

/**
 * Scratch Link compatible BLE session.
 *
 * Serves the `/scratch/ble` websocket route so that openblock-vm's
 * ScratchLinkBLE backend (the fallback used when Web Bluetooth is not
 * available: http deployments, non-Chromium browsers) works against
 * openblock-link. The JSON-RPC surface mirrors the official scratch-link
 * BLE network protocol as actually used by openblock-vm `src/io/ble.js`:
 *
 *   client -> server methods:
 *     discover {filters, optionalServices}   start scanning
 *     connect {peripheralId}                 connect a discovered peripheral
 *     write {serviceId, characteristicId, message, encoding, withResponse}
 *     read {serviceId, characteristicId, startNotifications}
 *     startNotifications {serviceId, characteristicId}
 *     stopNotifications {serviceId, characteristicId}
 *     getServices {}                         list discovered service uuids
 *   server -> client notifications:
 *     didDiscoverPeripheral {peripheralId, name, rssi}
 *     characteristicDidChange {serviceId, characteristicId, message, encoding}
 *
 * An unexpected peripheral disconnect closes the websocket, which is how
 * scratch-link reports connection loss (the vm listens on socket close).
 *
 * The underlying Bluetooth stack is @stoprocent/noble: N-API prebuilds,
 * native WinRT bindings on Windows (no WinUSB/Zadig driver replacement),
 * CoreBluetooth on macOS and HCI/D-Bus on Linux.
 */

/**
 * How long to wait for the Bluetooth adapter to power on before failing
 * a discovery request.
 * @readonly
 */
const ADAPTER_POWER_ON_TIMEOUT = 8000;

/**
 * Suffix (and prefix) of the Bluetooth base UUID. 128-bit UUIDs of the
 * form 0000xxxx-0000-1000-8000-00805f9b34fb are aliases of the 16-bit
 * UUID xxxx, which is the short form noble reports for standard services.
 * @readonly
 */
const BLUETOOTH_BASE_UUID_SUFFIX = '00001000800000805f9b34fb';

// The noble module is a process wide singleton wrapping the Bluetooth
// adapter. Loaded lazily so machines without the optional native module
// (or without an adapter) can still run every other link session type.
let nobleInstance = null;
let nobleLoadError = null;

class BLESession extends Session {
    constructor (socket) {
        super(socket);

        this._type = 'ble';
        this.peripheral = null;
        this.services = null;
        this.reportedPeripherals = {};
        this.discoverFilters = null;
        this.characteristics = {};
        this.notifyHandlers = {};
        this.scanning = false;
        this.isInDisconnect = false;

        this._onDiscover = this._onDiscover.bind(this);
        this._onPeripheralDisconnect = this._onPeripheralDisconnect.bind(this);
    }

    /**
     * Resolve the noble singleton, loading it on first use.
     * @return {object} the noble instance.
     */
    getNoble () {
        if (BLESession.nobleOverride) {
            return BLESession.nobleOverride;
        }
        if (!nobleInstance && !nobleLoadError) {
            try {
                // eslint-disable-next-line global-require
                const mod = require('@stoprocent/noble');
                nobleInstance = typeof mod.withBindings === 'function' ?
                    mod.withBindings('default') : mod;
            } catch (e) {
                nobleLoadError = e;
            }
        }
        if (!nobleInstance) {
            throw new Error(`Bluetooth is not available on this machine: ${nobleLoadError.message}`);
        }
        return nobleInstance;
    }

    /**
     * Normalize a service/characteristic UUID to noble's form: lowercase
     * hex without dashes, standard base UUIDs shortened to 16 bit.
     * @param {string|number} uuid - client provided UUID (number or string).
     * @return {string} normalized UUID.
     */
    static normalizeUuid (uuid) {
        if (uuid === null || typeof uuid === 'undefined') {
            return '';
        }
        let hex;
        if (typeof uuid === 'number') {
            hex = uuid.toString(16);
            while (hex.length < 4) {
                hex = `0${hex}`;
            }
        } else {
            hex = String(uuid)
                .toLowerCase()
                .replace(/-/g, '');
        }
        if (hex.length === 32 &&
            hex.indexOf('0000') === 0 &&
            hex.indexOf(BLUETOOTH_BASE_UUID_SUFFIX) === 8) {
            hex = hex.substring(4, 8);
        }
        return hex;
    }

    async didReceiveCall (method, params, completion) {
        // Report errors via the JSON-RPC response: an exception escaping
        // this async handler would crash the link process as an unhandled
        // rejection and leave the client waiting forever.
        try {
            switch (method) {
            case 'discover':
                await this.discover(params);
                completion(null, null);
                break;
            case 'connect':
                await this.connect(params);
                completion(null, null);
                break;
            case 'write':
                completion(await this.write(params), null);
                break;
            case 'read':
                completion(await this.read(params), null);
                break;
            case 'startNotifications':
                await this.startNotifications(params);
                completion(null, null);
                break;
            case 'stopNotifications':
                await this.stopNotifications(params);
                completion(null, null);
                break;
            case 'getServices':
                completion((this.services || []).map(
                    service => BLESession.normalizeUuid(service.uuid)), null);
                break;
            case 'pingMe':
                completion('willPing', null);
                this.sendRemoteRequest('ping', null, () => {});
                break;
            default:
                throw new Error(`Method not found`);
            }
        } catch (err) {
            completion(null, {message: `${(err && err.message) || err}`});
        }
    }

    /**
     * Start scanning for peripherals matching the discovery filters.
     * @param {object} params - {filters, optionalServices}.
     * @return {Promise} resolved once scanning started.
     */
    async discover (params) {
        if (this.peripheral) {
            throw new Error('cannot discover when connected');
        }
        const filters = params && params.filters;
        if (!Array.isArray(filters) || filters.length < 1) {
            throw new Error('discovery request must include filters');
        }

        const noble = this.getNoble();
        await this._waitAdapterPoweredOn(noble);

        this.reportedPeripherals = {};
        this.discoverFilters = filters.map(filter => ({
            services: Array.isArray(filter.services) ?
                filter.services.map(BLESession.normalizeUuid) : null,
            name: typeof filter.name === 'string' ? filter.name : null,
            namePrefix: typeof filter.namePrefix === 'string' ? filter.namePrefix : null,
            manufacturerData: filter.manufacturerData || null
        }));

        // When every filter constrains services the adapter can prefilter;
        // a name-only filter (e.g. gdx-for) needs an unfiltered scan.
        let scanServices = [];
        if (this.discoverFilters.every(filter => filter.services && filter.services.length > 0)) {
            const union = {};
            this.discoverFilters.forEach(filter => {
                filter.services.forEach(uuid => {
                    union[uuid] = true;
                });
            });
            scanServices = Object.keys(union);
        }

        noble.removeListener('discover', this._onDiscover);
        noble.on('discover', this._onDiscover);

        await new Promise((resolve, reject) => {
            noble.startScanning(scanServices, false, err => {
                if (err) {
                    return reject(err);
                }
                return resolve();
            });
        });
        this.scanning = true;
    }

    /**
     * Handle a peripheral advertisement, report it when it matches the
     * discovery filters.
     * @param {object} peripheral - noble peripheral object.
     */
    _onDiscover (peripheral) {
        if (!peripheral || !this.discoverFilters) {
            return;
        }
        const advertisement = peripheral.advertisement || {};
        if (!this._matchesFilters(advertisement)) {
            return;
        }
        this.reportedPeripherals[peripheral.id] = peripheral;
        this.sendRemoteRequest('didDiscoverPeripheral', {
            peripheralId: peripheral.id,
            name: advertisement.localName || peripheral.id,
            rssi: peripheral.rssi
        });
    }

    /**
     * Whether an advertisement matches at least one discovery filter.
     * @param {object} advertisement - noble advertisement object.
     * @return {boolean} true when it matches.
     */
    _matchesFilters (advertisement) {
        const advertisedUuids = (advertisement.serviceUuids || [])
            .map(BLESession.normalizeUuid);
        const localName = advertisement.localName || '';

        return this.discoverFilters.some(filter => {
            if (filter.services && filter.services.length > 0) {
                const hasAll = filter.services.every(
                    uuid => advertisedUuids.indexOf(uuid) !== -1);
                if (!hasAll) {
                    return false;
                }
            }
            if (filter.name !== null && filter.name !== localName) {
                return false;
            }
            if (filter.namePrefix !== null && localName.indexOf(filter.namePrefix) !== 0) {
                return false;
            }
            if (filter.manufacturerData &&
                !BLESession._matchesManufacturerData(advertisement, filter.manufacturerData)) {
                return false;
            }
            return true;
        });
    }

    /**
     * Match the manufacturer data section of an advertisement against a
     * scratch-link style manufacturerData filter: an object keyed by
     * company id with optional dataPrefix / mask byte arrays.
     * @param {object} advertisement - noble advertisement object.
     * @param {object} manufacturerData - filter spec.
     * @return {boolean} true when it matches.
     */
    static _matchesManufacturerData (advertisement, manufacturerData) {
        const raw = advertisement.manufacturerData;
        if (!raw || raw.length < 2) {
            return false;
        }
        const companyId = raw.readUInt16LE(0);
        const body = raw.slice(2);
        return Object.keys(manufacturerData).every(key => {
            if (Number(key) !== companyId) {
                return false;
            }
            const spec = manufacturerData[key] || {};
            const prefix = spec.dataPrefix || [];
            const mask = spec.mask || [];
            for (let i = 0; i < prefix.length; i++) {
                const maskByte = typeof mask[i] === 'number' ? mask[i] : 0xFF;
                if (((body[i] || 0) & maskByte) !== ((prefix[i] || 0) & maskByte)) {
                    return false;
                }
            }
            return true;
        });
    }

    /**
     * Connect to a previously discovered peripheral and index its GATT
     * services and characteristics.
     * @param {object} params - {peripheralId}.
     * @return {Promise} resolved when connected and discovered.
     */
    async connect (params) {
        const peripheralId = params && params.peripheralId;
        if (this.peripheral) {
            // Reconnecting to the peripheral this session is already
            // connected to is a no-op: the client may retry a connect
            // after a transient RPC error while the link is fine.
            if (this.peripheral.id === peripheralId) {
                return;
            }
            throw new Error('already connected to peripheral');
        }
        const peripheral = this.reportedPeripherals[peripheralId];
        if (!peripheral) {
            throw new Error(`invalid peripheral ID: ${peripheralId}`);
        }

        this._stopScanning();

        await new Promise((resolve, reject) => {
            peripheral.connect(err => {
                if (err) {
                    return reject(err);
                }
                return resolve();
            });
        });

        peripheral.once('disconnect', this._onPeripheralDisconnect);

        // Discover everything: filter services plus optionalServices, and
        // whatever else the board exposes. The device counts are small on
        // the supported peripherals and this keeps read/write lookups
        // trivial and complete.
        const services = await new Promise((resolve, reject) => {
            peripheral.discoverAllServicesAndCharacteristics((err, discovered) => {
                if (err) {
                    return reject(err);
                }
                return resolve(discovered || []);
            });
        });

        this.characteristics = {};
        services.forEach(service => {
            (service.characteristics || []).forEach(characteristic => {
                const key = BLESession._characteristicKey(service.uuid, characteristic.uuid);
                this.characteristics[key] = characteristic;
            });
        });
        this.services = services;
        this.peripheral = peripheral;
    }

    static _characteristicKey (serviceUuid, characteristicUuid) {
        return `${BLESession.normalizeUuid(serviceUuid)}:${BLESession.normalizeUuid(characteristicUuid)}`;
    }

    /**
     * Look up a discovered characteristic.
     * @param {string|number} serviceId - client provided service UUID.
     * @param {string|number} characteristicId - client provided characteristic UUID.
     * @return {object} noble characteristic.
     */
    _getCharacteristic (serviceId, characteristicId) {
        if (!this.peripheral) {
            throw new Error('not connected to a peripheral');
        }
        const key = BLESession._characteristicKey(serviceId, characteristicId);
        const characteristic = this.characteristics[key];
        if (!characteristic) {
            throw new Error(`unknown characteristic: ${serviceId} ${characteristicId}`);
        }
        return characteristic;
    }

    /**
     * Write data to a characteristic.
     * @param {object} params - {serviceId, characteristicId, message, encoding, withResponse}.
     * @return {Promise<number>} number of bytes written.
     */
    async write (params) {
        const {serviceId, characteristicId, message, encoding, withResponse} = params;
        const characteristic = this._getCharacteristic(serviceId, characteristicId);
        const buffer = Buffer.from(message, encoding || 'base64');

        let withoutResponse;
        if (withResponse === true) {
            withoutResponse = false;
        } else if (withResponse === false) {
            withoutResponse = true;
        } else {
            // Unspecified: follow what the characteristic supports,
            // preferring the faster write-without-response.
            const properties = characteristic.properties || [];
            withoutResponse = properties.indexOf('writeWithoutResponse') !== -1;
        }

        await new Promise((resolve, reject) => {
            characteristic.write(buffer, withoutResponse, err => {
                if (err) {
                    return reject(err);
                }
                return resolve();
            });
        });
        return buffer.length;
    }

    /**
     * Read a characteristic value, optionally subscribing to notifications.
     * @param {object} params - {serviceId, characteristicId, startNotifications}.
     * @return {Promise<object>} {message, encoding}.
     */
    async read (params) {
        const {serviceId, characteristicId, startNotifications} = params;
        const characteristic = this._getCharacteristic(serviceId, characteristicId);

        const data = await new Promise((resolve, reject) => {
            characteristic.read((err, value) => {
                if (err) {
                    return reject(err);
                }
                return resolve(value || Buffer.alloc(0));
            });
        });

        if (startNotifications) {
            await this._subscribe(characteristic, serviceId, characteristicId);
        }

        return {
            message: data.toString('base64'),
            encoding: 'base64'
        };
    }

    /**
     * Subscribe to characteristic notifications.
     * @param {object} params - {serviceId, characteristicId}.
     * @return {Promise} resolved when subscribed.
     */
    startNotifications (params) {
        const {serviceId, characteristicId} = params;
        const characteristic = this._getCharacteristic(serviceId, characteristicId);
        return this._subscribe(characteristic, serviceId, characteristicId);
    }

    /**
     * Unsubscribe from characteristic notifications.
     * @param {object} params - {serviceId, characteristicId}.
     * @return {Promise} resolved when unsubscribed.
     */
    async stopNotifications (params) {
        const {serviceId, characteristicId} = params;
        const characteristic = this._getCharacteristic(serviceId, characteristicId);
        const key = BLESession._characteristicKey(serviceId, characteristicId);

        const handler = this.notifyHandlers[key];
        if (handler) {
            characteristic.removeListener('data', handler);
            delete this.notifyHandlers[key];
        }
        await new Promise((resolve, reject) => {
            characteristic.unsubscribe(err => {
                if (err) {
                    return reject(err);
                }
                return resolve();
            });
        });
    }

    /**
     * Attach the notification handler and subscribe once.
     * @param {object} characteristic - noble characteristic.
     * @param {string|number} serviceId - client form, echoed back in events.
     * @param {string|number} characteristicId - client form, echoed back.
     * @return {Promise} resolved when subscribed.
     * @private
     */
    _subscribe (characteristic, serviceId, characteristicId) {
        const key = BLESession._characteristicKey(serviceId, characteristicId);
        if (this.notifyHandlers[key]) {
            return Promise.resolve();
        }
        const handler = data => {
            this.sendRemoteRequest('characteristicDidChange', {
                serviceId: serviceId,
                characteristicId: characteristicId,
                message: data.toString('base64'),
                encoding: 'base64'
            });
        };
        this.notifyHandlers[key] = handler;
        characteristic.on('data', handler);

        return new Promise((resolve, reject) => {
            characteristic.subscribe(err => {
                if (err) {
                    characteristic.removeListener('data', handler);
                    delete this.notifyHandlers[key];
                    return reject(err);
                }
                return resolve();
            });
        });
    }

    /**
     * Wait for the Bluetooth adapter to be powered on.
     * @param {object} noble - the noble instance.
     * @return {Promise} resolved when the adapter is ready.
     * @private
     */
    _waitAdapterPoweredOn (noble) {
        if (noble.state === 'poweredOn') {
            return Promise.resolve();
        }
        if (noble.state === 'unsupported') {
            return Promise.reject(new Error('Bluetooth is not supported on this machine'));
        }
        return new Promise((resolve, reject) => {
            let timer = null;
            const onStateChange = state => {
                if (state === 'poweredOn') {
                    clearTimeout(timer);
                    noble.removeListener('stateChange', onStateChange);
                    resolve();
                } else if (state === 'unsupported') {
                    clearTimeout(timer);
                    noble.removeListener('stateChange', onStateChange);
                    reject(new Error('Bluetooth is not supported on this machine'));
                }
            };
            timer = setTimeout(() => {
                noble.removeListener('stateChange', onStateChange);
                reject(new Error(`Bluetooth adapter is not ready: ${noble.state}`));
            }, ADAPTER_POWER_ON_TIMEOUT);
            noble.on('stateChange', onStateChange);
        });
    }

    /**
     * Stop scanning and detach the discover listener.
     * @private
     */
    _stopScanning () {
        if (!this.scanning) {
            return;
        }
        this.scanning = false;
        try {
            const noble = this.getNoble();
            noble.removeListener('discover', this._onDiscover);
            noble.stopScanning();
        } catch (e) {
            // noble unavailable: nothing was scanning.
        }
    }

    /**
     * An unexpected peripheral disconnect: close the websocket, which is
     * how scratch-link signals connection loss to the client.
     */
    _onPeripheralDisconnect () {
        this.peripheral = null;
        this.services = null;
        this.characteristics = {};
        this.notifyHandlers = {};
        if (!this.isInDisconnect && this._socket &&
            this._socket.readyState === this._socket.OPEN) {
            console.log('BLE peripheral disconnected unexpectedly, closing session');
            this._socket.close();
        }
    }

    dispose () {
        this.isInDisconnect = true;
        this._stopScanning();

        const peripheral = this.peripheral;
        if (peripheral) {
            peripheral.removeListener('disconnect', this._onPeripheralDisconnect);
            try {
                peripheral.disconnect();
            } catch (e) {
                // already gone
            }
        }
        this.peripheral = null;
        this.services = null;
        this.reportedPeripherals = {};
        this.discoverFilters = null;
        this.characteristics = {};
        this.notifyHandlers = {};

        super.dispose();
    }
}

/**
 * Test hook: unit tests inject a fake noble implementation so the protocol
 * layer can be verified on machines without Bluetooth hardware.
 * @type {?object}
 */
BLESession.nobleOverride = null;

module.exports = BLESession;
