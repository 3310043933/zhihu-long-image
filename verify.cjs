// 运行：node verify.cjs。无需安装依赖；验证收集顺序、去重、短缺和画布拼接。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.textContent = '';
    this.classList = { add() {} }; this.width = 0; this.height = 0;
  }
  append(...children) { this.children.push(...children); }
  getClientRects() { return [{}]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  cloneNode() { return new Element(this.tagName); }
  scrollIntoView() {}
  getContext() { return { fillRect() {}, drawImage: (tile, x, y, ...resize) => {
    assert.equal(resize.length, 0, '拼接不得再次缩放');
    draws.push([x, y, tile.width, tile.height]);
  } }; }
  toBlob(cb) { cb({ type: 'image/png' }); }
}
function answer(id, hasContent = true) {
  const el = new Element(); el.dataset.aid = id;
  el.querySelector = selector => selector.includes('Rich') && hasContent ? new Element() : null;
  return el;
}
let pages = [];
let page = 0;
let draws = [];
const list = new Element();
list.scrollHeight = 10000;
list.querySelectorAll = selector => selector === '.AnswerItem' ? pages[page] || [] : [];
const sandbox = {
  console, URL, WeakSet, Set, Map, Math, Number, Blob, CompressionStream,
  setTimeout: fn => { fn(); return 1; },
  location: { pathname: '/question/2087509207285248045', href: 'https://www.zhihu.com/question/2087509207285248045' },
  document: {
    querySelector: () => list,
    createElement: tag => new Element(tag),
  },
  window: {
    innerHeight: 900,
    scrollTo: () => { page = 0; },
    scrollBy: () => { page = Math.min(page + 1, Math.max(0, pages.length - 1)); },
  },
  html2canvas: async (root, opts) => ({ width: Math.floor(opts.width * opts.scale), height: Math.floor(opts.height * opts.scale) }),
};
let source = fs.readFileSync(`${__dirname}/zhihu-long-image.user.js`, 'utf8');
source = source.replace("  const css = document.createElement('style');", `
  status = { textContent: '' };
  activeQuestion = questionID();
  globalThis.api = { dimensions, planParts, planPDFPages, webPLimits, createStreamingPNG, collect, render, questionID, CONFIG,
    cancel: () => { cancelled = true; },
    reset: () => { cancelled = false; activeQuestion = questionID(); } };
  return;
  const css = document.createElement('style');`);
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const api = sandbox.api;

(async () => {
  const overflowSize = api.webPLimits(900, 20000, 2);
  assert.ok(overflowSize.shrinkWidth < 1800 && overflowSize.shrinkHeight <= 16380);
  assert.ok(overflowSize.capacity * 2 <= 16380);
  const protectedImages = [{ top: 800, bottom: 1500 }, { top: 1900, bottom: 2600 }];
  const pagesWithImages = api.planPDFPages(3000, 1000, protectedImages, true);
  assert.equal(pagesWithImages[0].height, 800, '放不下的图片应整体移到下一页');
  let coveredHeight = 0;
  for (const page of pagesWithImages) {
    assert.equal(page.y, coveredHeight);
    assert.ok(page.height > 0 && page.height <= 1000);
    coveredHeight += page.height;
    assert.ok(!protectedImages.some(image => image.top < coveredHeight && image.bottom > coveredHeight), '分页线不能穿过图片');
  }
  assert.equal(coveredHeight, 3000, '分页不能丢失正文');
  assert.equal(api.planPDFPages(3000, 1000, protectedImages, false)[0].height, 1000, '关闭选项应恢复固定分页');
  assert.throws(() => api.planPDFPages(2000, 1000, [{ top: 0, bottom: 1500 }], true), /无法完整放入/);
  const a = answer('1'), b = answer('2'), c = answer('3');
  pages = [[a, b], [answer('2'), c]];
  let result = await api.collect(3);
  assert.equal(result.length, 3);
  assert.deepEqual(Array.from(result, el => el.children[2].textContent.split('/').at(-1)), ['1', '2', '3']);
  result = await api.collect(1);
  assert.equal(result.length, 1);
  pages = [[a]];
  assert.equal((await api.collect(4)).length, 1, '不足 X 应返回实际条数');
  pages = [[answer('broken', false), b]];
  await assert.rejects(api.collect(2), /未能读取正文/, '不得跳过解析失败的首条回答');
  api.cancel();
  await assert.rejects(api.collect(2), /已取消/);
  api.reset();
  sandbox.location.pathname = '/question/123/answer/456';
  assert.equal(api.questionID(), '123');
  await assert.rejects(api.collect(2), /页面已切换/);
  sandbox.location.pathname = '/question/2087509207285248045';
  api.reset();
  for (const height of [1000, 15000, 45000, 80000, 100000]) {
    const parts = api.planParts(900, height, 'split');
    let covered = 0;
    for (const size of parts) {
      assert.equal(size.scale, 2, '超长时必须保留设定倍率');
      assert.equal(size.width, 1800);
      assert.ok(size.height <= 30000 && size.width * size.height <= 45000000);
      assert.equal(size.y, covered, '分图必须连续且无重复');
      covered += size.cssHeight;
    }
    assert.equal(covered, height);
  }
  assert.throws(() => api.dimensions(900, 100000), /画布限制/);
  api.CONFIG.SCALE = 1.5;
  assert.throws(() => api.dimensions(900, 1000), /整数/);
  api.CONFIG.SCALE = 2;
  draws = [];
  const root = new Element();
  root.getBoundingClientRect = () => ({ height: 4501 });
  const [image] = await api.render(root, 'split');
  assert.equal(draws.length, 3);
  assert.equal(draws[0][1], 0);
  for (let i = 1; i < draws.length; i++) assert.equal(draws[i][1], draws[i - 1][1] + draws[i - 1][3]);
  assert.equal(draws.at(-1)[1] + draws.at(-1)[3], image.height, '拼接应覆盖最后一行');
  const offsets = [];
  sandbox.html2canvas = async (el, opts) => {
    offsets.push(opts.y);
    return { width: opts.width * opts.scale, height: opts.height * opts.scale };
  };
  root.getBoundingClientRect = () => ({ height: 26001 });
  draws = [];
  const images = await api.render(root, 'split');
  assert.equal(images.length, 3);
  assert.ok(offsets.includes(12500) && offsets.includes(25000), '第二张和第三张须从正确的原文位置截图');
  assert.equal(images.reduce((sum, part) => sum + part.height, 0), 52002);
  // 用 Node zlib 独立解码 PNG；逐块校验 CRC，重建所有 RGBA 行。
  async function decodePNG(blob) {
    const png = Buffer.from(await blob.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const idats = [];
    let width, height;
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      const type = png.toString('ascii', offset + 4, offset + 8);
      const data = png.subarray(offset + 8, offset + 8 + length);
      let crc = 0xffffffff;
      for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
      assert.equal((crc ^ 0xffffffff) >>> 0, png.readUInt32BE(offset + 8 + length), `CRC: ${type}`);
      if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
      if (type === 'IDAT') idats.push(data);
      if (type === 'IEND') assert.equal(offset + 12, png.length);
      offset += length + 12;
    }
    const raw = zlib.inflateSync(Buffer.concat(idats));
    const stride = width * 4;
    assert.equal(raw.length, (stride + 1) * height);
    const rgba = Buffer.alloc(stride * height);
    for (let row = 0; row < height; row++) {
      assert.equal(raw[row * (stride + 1)], 2);
      for (let b = 0; b < stride; b++) {
        rgba[row * stride + b] = (raw[row * (stride + 1) + 1 + b] + (row ? rgba[(row - 1) * stride + b] : 0)) & 255;
      }
    }
    return { width, height, rgba };
  }
  const pngWidth = 33, pngHeight = 40001;
  const encoder = api.createStreamingPNG(pngWidth, pngHeight);
  const expected = Buffer.alloc(pngWidth * pngHeight * 4);
  for (let row = 0; row < pngHeight; row += 137) {
    const count = Math.min(137, pngHeight - row);
    const block = expected.subarray(row * pngWidth * 4, (row + count) * pngWidth * 4);
    for (let i = 0; i < block.length; i++) block[i] = (i * 31 + row * 17 + (i >> 7)) & 255;
    await encoder.writeRows(block, count);
  }
  const decoded = await decodePNG(await encoder.finish());
  assert.equal(decoded.width, pngWidth);
  assert.equal(decoded.height, pngHeight, '单张 PNG 应能突破32767高度');
  assert.deepEqual(decoded.rgba, expected, '全部像素应与输入逐字节一致');
  const incomplete = api.createStreamingPNG(2, 2);
  await assert.rejects(incomplete.finish(), /行数不完整/);
  await incomplete.abort();
  const oldLimit = api.CONFIG.MAX_FILE_MB;
  api.CONFIG.MAX_FILE_MB = 0.00001;
  const limited = api.createStreamingPNG(2, 2);
  await assert.rejects(async () => {
    await limited.writeRows(new Uint8Array(16), 2);
    await limited.finish();
  }, /内存保护/);
  await limited.abort();
  api.CONFIG.MAX_FILE_MB = oldLimit;
  // 端到端模拟分块截图，确认 tile 起点、输出行数以及最终仅一个文件。
  api.CONFIG.WIDTH = 4;
  sandbox.html2canvas = async (el, opts) => {
    const tile = new Element('canvas');
    tile.width = opts.width * opts.scale;
    tile.height = opts.height * opts.scale;
    tile.getContext = () => ({ getImageData: (x, row, width, count) => {
      const data = new Uint8Array(width * count * 4);
      for (let r = 0; r < count; r++) data.fill((opts.y * opts.scale + row + r) & 255, r * width * 4, (r + 1) * width * 4);
      return { data };
    } });
    return tile;
  };
  root.getBoundingClientRect = () => ({ height: 2101 });
  const streamed = await api.render(root, 'single');
  assert.equal(streamed.length, 1);
  const streamedPNG = await decodePNG(streamed[0].blob);
  assert.equal(streamedPNG.height, 4202);
  for (let row = 0; row < 4202; row++) assert.equal(streamedPNG.rgba[row * 8 * 4], row & 255);
  console.log('PASS: 原有收集/分图检查；40001行单张PNG、独立CRC及zlib解码、所有RGBA像素无损一致、未完成及内存保护、分块到单文件的连续行检查。');
})().catch(error => { console.error(error); process.exitCode = 1; });
