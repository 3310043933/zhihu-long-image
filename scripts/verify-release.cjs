'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zli-release-'));
fs.cpSync(root, temporary, { recursive: true, filter: full => !['.git', 'dist', 'node_modules', 'test-results'].includes(path.basename(full)) });
function run(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(temporary, script), ...args], { cwd: temporary, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
try {
  run('scripts/configure-release.cjs', ['sample-owner/zhihu-long-image']);
  run('scripts/build.cjs');
  run('scripts/package.cjs');
  const source = fs.readFileSync(path.join(temporary, 'dist/zhihu-long-image.user.js'), 'utf8');
  assert.match(source, /@updateURL\s+https:\/\/github\.com\/sample-owner\/zhihu-long-image\/releases\/latest\/download\/zhihu-long-image.meta.js/);
  assert.match(source, /@downloadURL\s+https:\/\/github\.com\/sample-owner\/zhihu-long-image\/releases\/latest\/download\/zhihu-long-image.user.js/);
  const meta = fs.readFileSync(path.join(temporary, 'dist/zhihu-long-image.meta.js'), 'utf8');
  assert.match(meta, /@version/);
  assert.ok(!meta.includes('(() =>'));
  for (const file of ['zhihu-long-image-extension.zip', 'zhihu-long-image-source.zip', 'SHA256SUMS.txt']) assert.ok(fs.existsSync(path.join(temporary, 'dist', file)));
  const info = JSON.parse(fs.readFileSync(path.join(temporary, 'extension/release-info.json')));
  assert.equal(info.repository, 'sample-owner/zhihu-long-image');
  assert.ok(fs.existsSync(path.join(temporary, 'extension/install.html')));
  const invalid = spawnSync(process.execPath, [path.join(temporary, 'scripts/configure-release.cjs'), 'https://evil.example/owner/repo'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  console.log('PASS: 独立临时仓库配置、真实下载/更新地址生成、元数据、稳定ZIP名称、扩展内安装页及非法地址拒绝。无外部发布。');
} finally {
  const base = path.resolve(os.tmpdir()) + path.sep;
  if (!path.resolve(temporary).startsWith(base) || !path.basename(temporary).startsWith('zli-release-')) throw new Error('临时目录校验失败');
  fs.rmSync(temporary, { recursive: true, force: true });
}
