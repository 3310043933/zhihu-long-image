'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => !['.git', 'node_modules', 'dist', 'test-results'].includes(entry.name) && !entry.name.startsWith('.env')).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('打包不接受符号链接。');
    return entry.isDirectory() ? files(full) : [full];
  }).sort();
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(directory, output, prefix = '') {
  const blocks = [], central = [];
  let offset = 0;
  for (const full of files(directory)) {
    const name = Buffer.from(prefix + path.relative(directory, full).split(path.sep).join('/'));
    const data = fs.readFileSync(full);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01，固定时间便于复现
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    blocks.push(local, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x21, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(output, Buffer.concat([...blocks, index, end]));
}
if (!fs.existsSync(path.join(root, 'extension/core.js'))) throw new Error('请先运行 npm run build。');
zip(path.join(root, 'extension'), path.join(outDir, `zhihu-long-image-extension-v${version}.zip`));
fs.copyFileSync(path.join(outDir, `zhihu-long-image-extension-v${version}.zip`), path.join(outDir, 'zhihu-long-image-extension.zip'));
fs.copyFileSync(path.join(root, 'zhihu-long-image.user.js'), path.join(outDir, 'zhihu-long-image.user.js'));
const metadata = fs.readFileSync(path.join(root, 'zhihu-long-image.user.js'), 'utf8').match(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/m)?.[0];
if (!metadata) throw new Error('用户脚本元数据缺失。');
fs.writeFileSync(path.join(outDir, 'zhihu-long-image.meta.js'), metadata + '\n');
zip(root, path.join(outDir, `zhihu-long-image-source-v${version}.zip`), `zhihu-long-image/`);
fs.copyFileSync(path.join(outDir, `zhihu-long-image-source-v${version}.zip`), path.join(outDir, 'zhihu-long-image-source.zip'));
const names = [`zhihu-long-image-extension-v${version}.zip`, 'zhihu-long-image-extension.zip', 'zhihu-long-image.user.js', 'zhihu-long-image.meta.js', `zhihu-long-image-source-v${version}.zip`, 'zhihu-long-image-source.zip'];
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), names.map(name => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(outDir, name))).digest('hex')}  ${name}`).join('\n') + '\n');
console.log(`Packaged v${version}: ${names.join(', ')}`);
