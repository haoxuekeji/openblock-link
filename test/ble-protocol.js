/**
 * BLE session 协议层测试（无蓝牙硬件，注入 fake noble）。
 *
 * 覆盖：
 *  1. discover 过滤（services / namePrefix）→ didDiscoverPeripheral 通知；
 *  2. connect → GATT 索引；write / read / startNotifications /
 *     characteristicDidChange 全链路（base64、16bit/128bit UUID 归一化）；
 *  3. 意外断连 → 主动关闭 websocket（scratch-link 语义）；
 *  4. 回归：session id 从 1 开始（id=0 会被两端 falsy 判断丢弃）、
 *     result:null 的响应不再被误判为非法消息；
 *  5. 回归：serialport session async 异常走 JSON-RPC error 响应而不是
 *     unhandled rejection。
 * 退出码 0 = 通过；非 0 = 失败。
 */
const EventEmitter = require('events');

const BLESession = require('../src/session/ble');
const Session = require('../src/session/session');
const SerialportSession = require('../src/session/serialport');

let failures = 0;
const check = (cond, label) => {
    if (cond) {
        console.log(`ok: ${label}`);
    } else {
        failures += 1;
        console.error(`FAIL: ${label}`);
    }
};

/** 简易 fake websocket：记录发出的 JSON-RPC 帧。 */
class FakeSocket extends EventEmitter {
    constructor () {
        super();
        this.OPEN = 1;
        this.readyState = 1;
        this.sent = [];
        this.closed = false;
    }
    send (text) {
        this.sent.push(JSON.parse(text));
    }
    close () {
        this.closed = true;
        this.readyState = 3;
    }
    sentByMethod (method) {
        return this.sent.filter(frame => frame.method === method);
    }
}

/** fake noble characteristic。 */
class FakeCharacteristic extends EventEmitter {
    constructor (uuid, properties) {
        super();
        this.uuid = uuid;
        this.properties = properties || ['read', 'write', 'notify'];
        this.written = [];
        this.readValue = Buffer.from('hello');
        this.subscribed = false;
    }
    read (cb) {
        process.nextTick(() => cb(null, this.readValue));
    }
    write (data, withoutResponse, cb) {
        this.written.push({data: data, withoutResponse: withoutResponse});
        process.nextTick(() => cb(null));
    }
    subscribe (cb) {
        this.subscribed = true;
        process.nextTick(() => cb(null));
    }
    unsubscribe (cb) {
        this.subscribed = false;
        process.nextTick(() => cb(null));
    }
}

/** fake noble peripheral。 */
class FakePeripheral extends EventEmitter {
    constructor (id, localName, serviceUuids, services) {
        super();
        this.id = id;
        this.rssi = -42;
        this.advertisement = {
            localName: localName,
            serviceUuids: serviceUuids
        };
        this._services = services;
        this.connected = false;
    }
    connect (cb) {
        this.connected = true;
        process.nextTick(() => cb(null));
    }
    disconnect () {
        this.connected = false;
        this.emit('disconnect');
    }
    discoverAllServicesAndCharacteristics (cb) {
        process.nextTick(() => cb(null, this._services));
    }
}

/** fake noble 单例。 */
class FakeNoble extends EventEmitter {
    constructor () {
        super();
        this.state = 'poweredOn';
        this.scanning = false;
        this.lastScanServices = null;
        this.stopped = 0;
    }
    startScanning (serviceUuids, allowDuplicates, cb) {
        this.scanning = true;
        this.lastScanServices = serviceUuids;
        process.nextTick(() => cb(null));
    }
    stopScanning () {
        this.scanning = false;
        this.stopped += 1;
    }
}

const rpc = (session, id, method, params) => {
    // 走真实入口 onMessage：响应经 socket.send 回传，落入 FakeSocket.sent。
    session.onMessage(JSON.stringify({
        jsonrpc: '2.0', id: id, method: method, params: params
    }));
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const run = async () => {
    // ---- 回归：id 计数从 1 开始，null result 响应可被接收 ----
    const idSocket = new FakeSocket();
    const idSession = new Session(idSocket);
    let completionResult = 'not-called';
    idSession.sendRemoteRequest('probe', null, (result, error) => {
        completionResult = {result: result, error: error};
    });
    const probeFrame = idSocket.sent[0];
    check(probeFrame.id === 1, `server-initiated request id starts at 1 (got ${probeFrame.id})`);
    idSession.didReceiveMessage(JSON.stringify({jsonrpc: '2.0', id: 1, result: null}), () => {});
    check(completionResult !== 'not-called' && completionResult.error === null,
        'response with result:null routed to completion handler');

    // ---- BLE：discover / 过滤 / 上报 ----
    const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
    const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
    const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

    const fakeNoble = new FakeNoble();
    BLESession.nobleOverride = fakeNoble;

    const txChar = new FakeCharacteristic('6e400003b5a3f393e0a9e50e24dcca9e', ['notify']);
    const rxChar = new FakeCharacteristic('6e400002b5a3f393e0a9e50e24dcca9e', ['write', 'writeWithoutResponse']);
    const battChar = new FakeCharacteristic('2a19', ['read']);
    const board = new FakePeripheral('aa:bb:cc', 'OB32-test',
        ['6e400001b5a3f393e0a9e50e24dcca9e'],
        [
            {uuid: '6e400001b5a3f393e0a9e50e24dcca9e', characteristics: [txChar, rxChar]},
            {uuid: '180f', characteristics: [battChar]}
        ]);
    const other = new FakePeripheral('dd:ee:ff', 'SomethingElse', ['fee0'], []);

    const socket = new FakeSocket();
    const ble = new BLESession(socket);

    rpc(ble, 1, 'discover', {
        filters: [
            {services: [NUS]},
            {namePrefix: 'OB32', services: [NUS]}
        ],
        optionalServices: ['0000180f-0000-1000-8000-00805f9b34fb']
    });
    await wait(20);
    check(fakeNoble.scanning === true, 'discover starts scanning');
    check(Array.isArray(fakeNoble.lastScanServices) &&
        fakeNoble.lastScanServices.indexOf('6e400001b5a3f393e0a9e50e24dcca9e') !== -1,
    'scan uses normalized service uuid prefilter');

    fakeNoble.emit('discover', other);
    fakeNoble.emit('discover', board);
    await wait(10);
    const discovered = socket.sentByMethod('didDiscoverPeripheral');
    check(discovered.length === 1, `only matching peripheral reported (got ${discovered.length})`);
    check(discovered[0].params.peripheralId === 'aa:bb:cc' &&
        discovered[0].params.name === 'OB32-test',
    'didDiscoverPeripheral carries peripheralId and name');

    // ---- BLE：connect ----
    rpc(ble, 2, 'connect', {peripheralId: 'aa:bb:cc'});
    await wait(20);
    const connectResponse = socket.sent.filter(frame => frame.id === 2)[0];
    check(connectResponse && !connectResponse.error, 'connect succeeds');
    check(board.connected === true && fakeNoble.scanning === false,
        'connect stops scanning and connects peripheral');

    // ---- BLE：重复 connect 同一外设幂等成功（静默重连依赖）----
    rpc(ble, 20, 'connect', {peripheralId: 'aa:bb:cc'});
    await wait(20);
    const reconnectResponse = socket.sent.filter(frame => frame.id === 20)[0];
    check(reconnectResponse && !reconnectResponse.error,
        'connect to the already connected peripheral is idempotent');

    // ---- BLE：getServices 返回归一化服务 uuid ----
    rpc(ble, 21, 'getServices', {});
    await wait(20);
    const servicesResponse = socket.sent.filter(frame => frame.id === 21)[0];
    check(servicesResponse && Array.isArray(servicesResponse.result) &&
        servicesResponse.result.indexOf('6e400001b5a3f393e0a9e50e24dcca9e') !== -1 &&
        servicesResponse.result.indexOf('180f') !== -1,
    `getServices returns normalized service uuids (got ${servicesResponse && JSON.stringify(servicesResponse.result)})`);

    // ---- BLE：write（16 进制/128bit UUID 客户端原样传入）----
    const payload = Buffer.from([0x01, 0x02, 0x03]).toString('base64');
    rpc(ble, 3, 'write', {
        serviceId: NUS, characteristicId: NUS_RX,
        message: payload, encoding: 'base64'
    });
    await wait(20);
    const writeResponse = socket.sent.filter(frame => frame.id === 3)[0];
    check(writeResponse && writeResponse.result === 3, `write responds with byte count (got ${writeResponse && writeResponse.result})`);
    check(rxChar.written.length === 1 && rxChar.written[0].withoutResponse === true,
        'write honors characteristic properties (write without response preferred)');

    // ---- BLE：read（16bit uuid 数字形式）----
    rpc(ble, 4, 'read', {serviceId: 0x180F, characteristicId: 0x2A19});
    await wait(20);
    const readResponse = socket.sent.filter(frame => frame.id === 4)[0];
    check(readResponse && readResponse.result &&
        Buffer.from(readResponse.result.message, 'base64').toString() === 'hello',
    'read returns base64 message (numeric 16-bit uuids resolved)');

    // ---- BLE：startNotifications + characteristicDidChange ----
    rpc(ble, 5, 'startNotifications', {serviceId: NUS, characteristicId: NUS_TX});
    await wait(20);
    check(txChar.subscribed === true, 'startNotifications subscribes');
    txChar.emit('data', Buffer.from('notify!'));
    await wait(10);
    const changed = socket.sentByMethod('characteristicDidChange');
    check(changed.length === 1 &&
        Buffer.from(changed[0].params.message, 'base64').toString() === 'notify!' &&
        changed[0].params.serviceId === NUS,
    'characteristicDidChange forwards data with original ids');

    // ---- BLE：错误响应（未知 characteristic）而不是崩溃 ----
    rpc(ble, 6, 'write', {serviceId: 'ffff', characteristicId: 'eeee', message: 'AA=='});
    await wait(20);
    const badWrite = socket.sent.filter(frame => frame.id === 6)[0];
    check(badWrite && badWrite.error && `${badWrite.error.message}`.indexOf('unknown characteristic') !== -1,
        'unknown characteristic reported as JSON-RPC error');

    // ---- BLE：意外断连 → 关闭 websocket ----
    board.disconnect();
    await wait(10);
    check(socket.closed === true, 'unexpected peripheral disconnect closes the websocket');

    BLESession.nobleOverride = null;

    // ---- 回归：serialport async 异常 → JSON-RPC error 响应 ----
    const spSocket = new FakeSocket();
    const sp = new SerialportSession(spSocket);
    let unhandled = null;
    const onUnhandled = reason => {
        unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);
    rpc(sp, 7, 'connect', {peripheralId: 'COM_NOT_EXIST'});
    await wait(30);
    process.removeListener('unhandledRejection', onUnhandled);
    const spResponse = spSocket.sent.filter(frame => frame.id === 7)[0];
    check(spResponse && spResponse.error &&
        `${spResponse.error.message}`.indexOf('invalid peripheral ID') !== -1,
    'serialport connect error returns JSON-RPC error response');
    check(unhandled === null, 'serialport connect error causes no unhandled rejection');
    sp.dispose();

    if (failures > 0) {
        console.error(`ble-protocol: ${failures} 项失败`);
        process.exit(1);
    }
    console.log('ble-protocol: 全部通过');
    process.exit(0);
};

run().catch(err => {
    console.error(`ble-protocol: 异常 ${err.stack || err}`);
    process.exit(1);
});
