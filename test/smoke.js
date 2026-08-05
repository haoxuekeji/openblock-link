/**
 * OB-031C: openblock-link 服务启动烟测。
 *
 * 启动 OpenBlockLink（随机高位端口避免与本机常驻服务冲突），等待 ready，
 * HTTP GET / 应返回 200 与服务名，然后退出。
 * 退出码 0 = 通过；非 0 = 失败。
 */
const http = require('http');

const OpenBlockLink = require('../src/index');

const PORT = 20800 + Math.floor(Math.random() * 100);
const TIMEOUT_MS = 15000;

const timer = setTimeout(() => {
    console.error(`smoke: 超时（${TIMEOUT_MS}ms 内未完成）`);
    process.exit(1);
}, TIMEOUT_MS);

const link = new OpenBlockLink();

link.on('error', info => {
    console.error(`smoke: 服务报错 ${info}`);
    process.exit(1);
});

link.on('ready', () => {
    http.get(`http://127.0.0.1:${PORT}/`, res => {
        let body = '';
        res.on('data', chunk => {
            body += chunk;
        });
        res.on('end', () => {
            if (res.statusCode !== 200) {
                console.error(`smoke: HTTP ${res.statusCode}`);
                process.exit(1);
            }
            if (!body || body.length === 0) {
                console.error('smoke: 响应体为空');
                process.exit(1);
            }
            console.log(`smoke: OK (HTTP 200, server name: ${body})`);
            clearTimeout(timer);
            process.exit(0);
        });
    }).on('error', e => {
        console.error(`smoke: 请求失败 ${e.message}`);
        process.exit(1);
    });
});

link.listen(PORT, '0.0.0.0');
