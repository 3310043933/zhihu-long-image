'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json')));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['storage']);
assert.equal(manifest.version, require('../package.json').version);
assert.equal(manifest.author, 'jasonLi');
for (const script of [...manifest.content_scripts[0].js, manifest.background.service_worker, 'popup.js', 'install.js', 'install-config.js']) {
  const code = fs.readFileSync(path.join(root, 'extension', script), 'utf8');
  new vm.Script(code, { filename: script });
  if (!script.startsWith('vendor/')) assert.ok(!/\beval\s*\(|new Function\s*\(/.test(code), `${script} 不应动态执行代码`);
}
for (const [size, icon] of Object.entries(manifest.icons)) {
  const image = fs.readFileSync(path.join(root, 'extension', icon));
  assert.equal(image.readUInt32BE(16), Number(size));
  assert.equal(image.readUInt32BE(20), Number(size));
}
const generated = fs.readFileSync(path.join(root, 'extension/core.js'), 'utf8');
const original = fs.readFileSync(path.join(root, 'zhihu-long-image.user.js'), 'utf8');
const expected = original.replace(/^\/\/ ==UserScript==[\s\S]*?^\/\/ ==\/UserScript==\s*/m, '').replace("(() => {\n  'use strict';", "(async () => {\n  'use strict';\n  await globalThis.ZLI_READY;");
assert.equal(generated.split('\n').slice(1).join('\n'), expected, '扩展核心须与源文件一致，请重新build');

let listener;
let fetchCount = 0;
const sandbox = {
  URL, AbortController, setTimeout, clearTimeout, Uint8Array, btoa,
  fetch: async (url, options) => {
    fetchCount++;
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  },
  chrome: { runtime: { id: 'test-extension', onMessage: { addListener: fn => { listener = fn; } } } },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8') + '\nglobalThis.api = { allowedImageURL, allowedSender, fetchImageData };', sandbox);
const api = sandbox.api;
for (const url of ['https://pic1.zhimg.com/image.jpg', 'https://zhimg.com/a']) assert.ok(api.allowedImageURL(url));
for (const url of ['https://zhimg.com.evil.test/a', 'https://evilzhimg.com/a', 'http://pic1.zhimg.com/a', 'https://user:pass@pic1.zhimg.com/a', 'https://pic1.zhimg.com:8443/a', 'data:image/png;base64,AA', 'file:///secret']) assert.ok(!api.allowedImageURL(url), url);
const validSender = { id: 'test-extension', frameId: 0, url: 'https://www.zhihu.com/question/123' };
assert.ok(api.allowedSender(validSender));
for (const sender of [{ ...validSender, frameId: 1 }, { ...validSender, id: 'other' }, { ...validSender, url: 'https://evil.test' }, {}]) assert.ok(!api.allowedSender(sender));

(async () => {
  await assert.rejects(api.fetchImageData('https://evil.test/picture'), /只允许/);
  assert.equal(fetchCount, 0);
  const result = await api.fetchImageData('https://pic1.zhimg.com/example.png');
  assert.equal(result.ok, true);
  assert.equal(result.base64, 'iVBORw==');
  let reply;
  assert.equal(listener({ type: 'ZLI_FETCH_IMAGE', url: 'https://pic1.zhimg.com/a' }, {}, value => { reply = value; }), false);
  assert.equal(reply.ok, false);
  assert.equal(fetchCount, 1);
  sandbox.fetch = async () => new Response('not an image', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(api.fetchImageData('https://pic1.zhimg.com/a'), /不是支持的图片/);
  sandbox.fetch = async () => new Response('small body', { headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) } });
  await assert.rejects(api.fetchImageData('https://pic1.zhimg.com/a'), /20MB/);

  let bridgeListener;
  let savedSettings;
  const bridge = {
    Blob, atob, Uint8Array,
    chrome: {
      storage: { local: { get: async () => ({ ANSWER_COUNT: 7, SCALE: 3, FORMAT: 'html', PDF_KEEP_IMAGES: false }), set: async value => { savedSettings = value; } } },
      runtime: { sendMessage: async () => ({ ok: true, mime: 'image/png', base64: 'iVBORw==' }), onMessage: { addListener: fn => { bridgeListener = fn; } } },
    },
  };
  vm.createContext(bridge);
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/bridge.js'), 'utf8'), bridge);
  await bridge.ZLI_READY;
  assert.equal(bridge.ZLI_PLATFORM_SETTINGS.ANSWER_COUNT, 7);
  assert.equal(bridge.ZLI_PLATFORM_SETTINGS.SCALE, 3);
  assert.equal(bridge.ZLI_PLATFORM_SETTINGS.FORMAT, 'html');
  assert.equal(bridge.ZLI_PLATFORM_SETTINGS.PDF_KEEP_IMAGES, false);
  await bridge.ZLI_SAVE_SETTINGS({ ANSWER_COUNT: 11, SCALE: 4, FORMAT: 'svg', PDF_KEEP_IMAGES: true, IGNORE_ME: 'not saved' });
  assert.deepEqual(JSON.parse(JSON.stringify(savedSettings)), { ANSWER_COUNT: 11, SCALE: 4, FORMAT: 'svg', PDF_KEEP_IMAGES: true });
  await new Promise((resolve, reject) => bridge.GM_xmlhttpRequest({ url: 'https://pic1.zhimg.com/a', onload: response => {
    assert.equal(response.status, 200); assert.equal(response.response.type, 'image/png'); assert.equal(response.response.size, 4); resolve();
  }, onerror: reject }));
  assert.equal(typeof bridgeListener, 'function');
  console.log('PASS: Manifest V3、最小权限、版本/作者、生成源码同步、图标、来源校验、图片域名/协议/大小/类型限制、无Cookie请求、扩展设置和图片桥接。');
})().catch(error => { console.error(error); process.exitCode = 1; });
