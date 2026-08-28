/**
 * Serialport session 协议层回环测试（无硬件，注入 fake SerialPort）。
 *
 * 覆盖：
 *  1. discover：'*' 与 pnpid 精确过滤 → didDiscoverPeripheral 通知；
 *  2. connect / read / write / updateBaudrate / disconnect 全链路；
 *  3. 回环校验：write 的字节从 fake 串口 echo 回来，以 onMessage
 *     （base64）通知客户端，且 write 响应携带真实写入字节数
 *     （回归：旧代码先 resolve() 后 drain，客户端总是拿到 null）；
 *  4. drain 报错走 JSON-RPC error 响应而不是悬挂/崩溃；
 *  5. 回归：getServices / pingMe 死代码已移除 → Method not found；
 *  6. 已连接时 discover 报错（cannot discover when connected）。
 * 退出码 0 = 通过；非 0 = 失败。
 */
const EventEmitter = require('events');

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
    responseById (id) {
        return this.sent.filter(frame => frame.id === id && !frame.method)[0];
    }
}

/**
 * Fake SerialPort：open/set/write/drain/update/flush/close 全部成功，
 * write 的数据在 nextTick echo 回 'data' 事件（回环）。
 */
class FakeSerialPort extends EventEmitter {
    constructor (options) {
        super();
        this.path = options.path;
        this.baudRate = options.baudRate;
        this.isOpen = false;
        this.written = [];
        FakeSerialPort.instances.push(this);
    }
    static list () {
        return Promise.resolve(FakeSerialPort.ports);
    }
    open (cb) {
        this.isOpen = true;
        process.nextTick(() => cb(null));
    }
    set (options, cb) {
        process.nextTick(() => cb(null));
    }
    update (options, cb) {
        this.baudRate = options.baudRate;
        process.nextTick(() => cb(null));
    }
    write (buffer, encoding, cb) {
        this.written.push(buffer);
        process.nextTick(() => {
            cb(null);
            // 回环：写出的字节原样回读。
            this.emit('data', buffer);
        });
    }
    drain (cb) {
        process.nextTick(() => cb(FakeSerialPort.drainError));
    }
    pause () {}
    flush (cb) {
        process.nextTick(() => cb());
    }
    close (cb) {
        this.isOpen = false;
        process.nextTick(() => cb(null));
    }
}
FakeSerialPort.ports = [
    {path: '/dev/fake0', vendorId: '2341', productId: '0043'},
    {path: '/dev/fake1', vendorId: 'dead', productId: 'beef'}
];
FakeSerialPort.instances = [];
FakeSerialPort.drainError = null;

const rpc = (session, id, method, params) => {
    session.onMessage(JSON.stringify({
        jsonrpc: '2.0', id: id, method: method, params: params
    }));
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const CONNECT_PARAMS = {
    peripheralId: '/dev/fake0',
    peripheralConfig: {config: {baudRate: 115200, dataBits: 8, stopBits: 1}}
};

const run = async () => {
    SerialportSession.serialPortOverride = FakeSerialPort;

    const socket = new FakeSocket();
    const session = new SerialportSession(socket);

    // ---- discover：'*' 通配 ----
    rpc(session, 1, 'discover', {filters: {pnpid: ['*']}});
    await wait(20);
    let discovered = socket.sentByMethod('didDiscoverPeripheral');
    check(discovered.length === 2, `wildcard discover reports every port (got ${discovered.length})`);

    // ---- discover：pnpid 精确过滤 ----
    socket.sent.length = 0;
    rpc(session, 2, 'discover', {filters: {pnpid: ['USB\\VID_2341&PID_0043']}});
    await wait(20);
    discovered = socket.sentByMethod('didDiscoverPeripheral');
    check(discovered.length === 1 && discovered[0].params.peripheralId === '/dev/fake0',
        'pnpid filter reports only the matching port');

    // ---- connect ----
    rpc(session, 3, 'connect', CONNECT_PARAMS);
    await wait(30);
    const connectResponse = socket.responseById(3);
    check(connectResponse && !connectResponse.error, 'connect succeeds');
    const port = FakeSerialPort.instances[0];
    check(port && port.isOpen === true && port.baudRate === 115200, 'port opened with configured baudrate');

    // ---- 已连接时 discover 拒绝 ----
    rpc(session, 4, 'discover', {filters: {pnpid: ['*']}});
    await wait(20);
    const discoverBusy = socket.responseById(4);
    check(discoverBusy && discoverBusy.error &&
        `${discoverBusy.error.message}`.indexOf('cannot discover when connected') !== -1,
    'discover while connected returns JSON-RPC error');

    // ---- read 打开数据上报，write 回环 ----
    rpc(session, 5, 'read', {});
    await wait(10);
    const payload = Buffer.from('hello');
    rpc(session, 6, 'write', {message: payload.toString('base64'), encoding: 'base64'});
    await wait(30);
    const writeResponse = socket.responseById(6);
    check(writeResponse && writeResponse.result === payload.length,
        `write responds with byte count after drain (got ${writeResponse && writeResponse.result})`);
    const echoed = socket.sentByMethod('onMessage');
    check(echoed.length === 1 &&
        Buffer.from(echoed[0].params.message, 'base64').toString() === 'hello' &&
        echoed[0].params.encoding === 'base64',
    'loopback: written bytes come back through onMessage as base64');

    // ---- updateBaudrate ----
    rpc(session, 7, 'updateBaudrate', {baudRate: 9600});
    await wait(30);
    const baudResponse = socket.responseById(7);
    check(baudResponse && !baudResponse.error && port.baudRate === 9600, 'updateBaudrate applies and responds');

    // ---- drain 出错 → JSON-RPC error（不悬挂、不崩溃）----
    FakeSerialPort.drainError = new Error('boom');
    let unhandled = null;
    const onUnhandled = reason => {
        unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandled);
    rpc(session, 8, 'write', {message: 'AA==', encoding: 'base64'});
    await wait(30);
    FakeSerialPort.drainError = null;
    process.removeListener('unhandledRejection', onUnhandled);
    const failedWrite = socket.responseById(8);
    check(failedWrite && failedWrite.error &&
        `${failedWrite.error.message}`.indexOf('boom') !== -1,
    'drain error surfaces as JSON-RPC error response');
    check(unhandled === null, 'drain error causes no unhandled rejection');

    // ---- getServices / pingMe 死代码已移除 ----
    rpc(session, 9, 'getServices', {});
    rpc(session, 10, 'pingMe', {});
    await wait(20);
    const services = socket.responseById(9);
    const ping = socket.responseById(10);
    check(services && services.error && `${services.error.message}`.indexOf('Method not found') !== -1,
        'getServices removed from the serialport session');
    check(ping && ping.error && `${ping.error.message}`.indexOf('Method not found') !== -1,
        'pingMe removed from the serialport session');

    // ---- disconnect ----
    rpc(session, 11, 'disconnect', {});
    await wait(30);
    const disconnectResponse = socket.responseById(11);
    check(disconnectResponse && !disconnectResponse.error, 'disconnect succeeds');
    check(port.isOpen === false, 'port closed');

    // ---- 断开后的 write 直接返回 0 字节 ----
    rpc(session, 12, 'write', {message: 'AA==', encoding: 'base64'});
    await wait(20);
    const idleWrite = socket.responseById(12);
    check(idleWrite && !idleWrite.error && idleWrite.result === 0,
        'write with no open port reports 0 bytes written');

    session.dispose();
    SerialportSession.serialPortOverride = null;

    if (failures > 0) {
        console.error(`serialport-protocol: ${failures} 项失败`);
        process.exit(1);
    }
    console.log('serialport-protocol: 全部通过');
    process.exit(0);
};

run().catch(err => {
    console.error(`serialport-protocol: 异常 ${err.stack || err}`);
    process.exit(1);
});
