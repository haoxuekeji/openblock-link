/**
 * P2-2: 无自动复位板子的烧录引导。
 *
 * 校验 esptool sync 失败的识别与中文 BOOT 引导:
 * 1. isEsptoolSyncFailure 对真实 esptool 输出的正/负样本判定正确;
 * 2. runEsptool 遇到 sync 失败时 reject 的 message 携带 BOOT 引导,
 *    控制台输出包含"按住 BOOT"的引导文本;
 * 3. 其他失败仍是原始退出码消息,成功路径不受影响。
 * 退出码 0 = 通过;非 0 = 失败。
 */
const assert = require('assert');
const path = require('path');

const MicroPython = require('../src/upload/microPython');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-esptool.js');

const makeTool = () => {
    const console_ = [];
    const tool = new MicroPython(
        '/dev/null', {}, '/tmp/openblock-test', '/tmp/openblock-test-tools',
        text => console_.push(text), null
    );
    // Replace the python + esptool pair with node + fixture so the real
    // runEsptool spawn/collect/reject path runs without hardware.
    tool._pyPath = process.execPath;
    tool._esptoolPath = FIXTURE;
    return {tool, console_};
};

const syncFailureSamples = [
    'A fatal error occurred: Failed to connect to ESP32: No serial data received.',
    'A fatal error occurred: Failed to connect to ESP32-C3: Wrong boot mode detected (0x13)! ' +
        'The chip needs to be in download mode.',
    'A fatal error occurred: Timed out waiting for packet header',
    'A fatal error occurred: Invalid head of packet (0x50): Possible serial noise or corruption.',
    'Connecting........_____....._____\nA fatal error occurred: Failed to connect to Espressif device: ' +
        'No serial data received.'
];

const notSyncFailureSamples = [
    'A fatal error occurred: MD5 of file does not match data in flash!',
    'FileNotFoundError: [Errno 2] No such file or directory: firmware.bin',
    'Hash of data verified.\nLeaving...\nHard resetting via RTS pin...',
    '',
    null
];

(async () => {
    syncFailureSamples.forEach(sample => {
        assert.ok(MicroPython.isEsptoolSyncFailure(sample),
            `应识别为 sync 失败: ${sample.split('\n').pop()}`);
    });
    notSyncFailureSamples.forEach(sample => {
        assert.ok(!MicroPython.isEsptoolSyncFailure(sample),
            `不应识别为 sync 失败: ${sample}`);
    });
    console.log('esptool-guidance: 识别函数正/负样本 OK');

    // sync 失败 → reject 携带 BOOT 引导,控制台输出引导文本
    {
        const {tool, console_} = makeTool();
        let rejected = null;
        try {
            await tool.runEsptool(['sync-failure']);
        } catch (err) {
            rejected = err;
        }
        assert.ok(rejected, 'sync 失败应当 reject');
        assert.ok(rejected.message.includes('BOOT'),
            `reject 消息应包含 BOOT 引导,实际: ${rejected.message}`);
        assert.ok(rejected.message.includes('未能与芯片同步'),
            `reject 消息应说明同步失败,实际: ${rejected.message}`);
        const consoleText = console_.join('');
        assert.ok(consoleText.includes('按住') && consoleText.includes('BOOT'),
            '控制台应输出按住 BOOT 的引导');
        assert.ok(consoleText.includes('Timed out waiting for packet header'),
            '原始 esptool 错误仍应透传到控制台');
        console.log('esptool-guidance: sync 失败转中文引导 OK');
    }

    // 其他失败 → 保持原始退出码消息,不出现 BOOT 引导
    {
        const {tool, console_} = makeTool();
        let rejected = null;
        try {
            await tool.runEsptool(['other-failure']);
        } catch (err) {
            rejected = err;
        }
        assert.ok(rejected, '非 sync 失败也应 reject');
        assert.strictEqual(rejected.message, 'esptool exited with code 1',
            `非 sync 失败应保持原消息,实际: ${rejected.message}`);
        assert.ok(!console_.join('').includes('BOOT'),
            '非 sync 失败不应输出 BOOT 引导');
        console.log('esptool-guidance: 非 sync 失败保持原样 OK');
    }

    // 成功路径不受影响
    {
        const {tool} = makeTool();
        const result = await tool.runEsptool(['success']);
        assert.strictEqual(result, 'Success', '成功路径应 resolve Success');
        console.log('esptool-guidance: 成功路径 OK');
    }

    console.log('esptool-guidance: 全部通过');
    process.exit(0);
})().catch(err => {
    console.error(`esptool-guidance: 失败 ${err.stack || err}`);
    process.exit(1);
});
