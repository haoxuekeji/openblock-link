/**
 * P2-3: Windows 便携 Python 工具链打包修复。
 *
 * 在临时目录里搭一个 Windows 布局(Python/Scripts)的假工具链:
 * 1. 自遮蔽的 pip wrapper(esptool.py)被注入 shadow guard,普通脚本不动;
 * 2. 缺失的 Scripts/obmpy 与 obmpy.cmd 被生成;
 * 3. 重复执行幂等;
 * 4. 有 python3 时做语义验证:修复前 wrapper 自遮蔽失败,
 *    修复后解析到 site-packages 真模块,obmpy wrapper 可运行。
 * 退出码 0 = 通过;非 0 = 失败。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const {fixPythonTools, hasShadowGuard} = require('../script/fix-python-tools');

const PIP_WRAPPER = [
    '#!C:\\obtools\\Python\\python.exe',
    '# -*- coding: utf-8 -*-',
    'import re',
    'import sys',
    '',
    'from esptool.__init__ import _main',
    '',
    "if __name__ == '__main__':",
    "    sys.argv[0] = re.sub(r'(-script\\.pyw?|\\.exe)?$', '', sys.argv[0])",
    '    sys.exit(_main())',
    ''
].join('\n');

// 引用其他模块的普通脚本,不应被改动。
const PLAIN_SCRIPT = [
    '#!/usr/bin/env python3',
    'import kflash_lib',
    'kflash_lib.main()',
    ''
].join('\n');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-fixtools-'));
const pythonDir = path.join(root, 'Python');
const scriptsDir = path.join(pythonDir, 'Scripts');
const siteDir = path.join(root, 'site');

fs.mkdirSync(scriptsDir, {recursive: true});
fs.writeFileSync(path.join(scriptsDir, 'esptool.py'), PIP_WRAPPER);
fs.writeFileSync(path.join(scriptsDir, 'kflash.py'), PLAIN_SCRIPT);

// site-packages 里的"真"模块,验证 guard 后 import 解析正确。
fs.mkdirSync(path.join(siteDir, 'esptool'), {recursive: true});
fs.writeFileSync(path.join(siteDir, 'esptool', '__init__.py'),
    'def _main():\n    print("REAL_ESPTOOL_OK")\n');
fs.mkdirSync(path.join(siteDir, 'obmpy'), {recursive: true});
fs.writeFileSync(path.join(siteDir, 'obmpy', '__init__.py'),
    'def _main():\n    print("REAL_OBMPY_OK")\n');

const pythonBin = (() => {
    for (const candidate of ['python3', 'python']) {
        const probe = spawnSync(candidate, ['--version']);
        if (probe.status === 0) {
            return candidate;
        }
    }
    return null;
})();

const runScript = script => spawnSync(pythonBin, [script], {
    env: Object.assign({}, process.env, {PYTHONPATH: siteDir}),
    encoding: 'utf8'
});

try {
    // 修复前:自遮蔽,wrapper 找到自己而不是 site-packages 的模块。
    if (pythonBin) {
        const before = runScript(path.join(scriptsDir, 'esptool.py'));
        assert.notStrictEqual(before.status, 0, '修复前 wrapper 应因自遮蔽失败');
        console.log('fix-python-tools: 修复前自遮蔽复现 OK');
    }

    const changed = fixPythonTools(pythonDir);
    assert.deepStrictEqual(changed.sort(),
        ['Scripts/esptool.py', 'Scripts/obmpy', 'Scripts/obmpy.cmd'],
        `首次修复应改 3 个文件,实际: ${changed.join(', ')}`);

    const patchedWrapper = fs.readFileSync(path.join(scriptsDir, 'esptool.py'), 'utf8');
    assert.ok(hasShadowGuard(patchedWrapper), 'esptool.py 应注入 shadow guard');
    assert.ok(patchedWrapper.indexOf('from esptool.__init__ import _main') >
        patchedWrapper.indexOf('end shadow guard'), 'guard 应在真实 import 之前');
    assert.ok(!hasShadowGuard(fs.readFileSync(path.join(scriptsDir, 'kflash.py'), 'utf8')),
        '非自遮蔽脚本不应被改动');
    assert.ok(fs.existsSync(path.join(scriptsDir, 'obmpy')), '应生成 Scripts/obmpy');
    assert.ok(fs.readFileSync(path.join(scriptsDir, 'obmpy.cmd'), 'utf8').includes('%~dp0obmpy'),
        'obmpy.cmd 应调用同目录 obmpy');
    console.log('fix-python-tools: 注入与生成 OK');

    const changedAgain = fixPythonTools(pythonDir);
    assert.deepStrictEqual(changedAgain, [], `重复执行应无改动,实际: ${changedAgain.join(', ')}`);
    const guardCount = patchedWrapper.split('end shadow guard').length - 1;
    assert.strictEqual(guardCount, 1, 'guard 只应注入一次');
    console.log('fix-python-tools: 幂等 OK');

    if (pythonBin) {
        const after = runScript(path.join(scriptsDir, 'esptool.py'));
        assert.strictEqual(after.status, 0,
            `修复后 wrapper 应运行成功,stderr: ${after.stderr}`);
        assert.ok(after.stdout.includes('REAL_ESPTOOL_OK'),
            `修复后应解析到 site-packages 真模块,stdout: ${after.stdout}`);

        const obmpyRun = runScript(path.join(scriptsDir, 'obmpy'));
        assert.strictEqual(obmpyRun.status, 0,
            `生成的 obmpy wrapper 应可运行,stderr: ${obmpyRun.stderr}`);
        assert.ok(obmpyRun.stdout.includes('REAL_OBMPY_OK'),
            `obmpy wrapper 应调用 obmpy 包入口,stdout: ${obmpyRun.stdout}`);
        console.log('fix-python-tools: python 语义验证 OK');
    } else {
        console.log('fix-python-tools: 未找到 python,跳过语义验证');
    }

    console.log('fix-python-tools: 全部通过');
} finally {
    fs.rmSync(root, {recursive: true, force: true});
}
