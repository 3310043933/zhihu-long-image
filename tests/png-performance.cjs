// 可选性能/正确性对比。ZLI_BASELINE 指向上一版用户脚本；使用合成页面，不访问个人账号。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.ZLI_TEST_OUTPUT || path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
function pixelHash(buffer) {
  const idat = [];
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20), type = buffer[25];
  assert.equal(buffer[24], 8);
  assert.ok(type === 2 || type === 6);
  const bpp = type === 2 ? 3 : 4, stride = width * bpp;
  for (let pos = 8; pos < buffer.length;) {
    const length = buffer.readUInt32BE(pos);
    if (buffer.toString('ascii', pos + 4, pos + 8) === 'IDAT') idat.push(buffer.subarray(pos + 8, pos + 8 + length));
    pos += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (stride + 1) * height);
  let prev = Buffer.alloc(stride), current = Buffer.alloc(stride);
  const rgba = Buffer.alloc(width * 4), hash = crypto.createHash('sha256');
  for (let row = 0; row < height; row++) {
    const start = row * (stride + 1), filter = raw[start];
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? current[i - bpp] : 0, up = prev[i], upperLeft = i >= bpp ? prev[i - bpp] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = up;
      else if (filter === 3) prediction = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upperLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
        prediction = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      } else assert.equal(filter, 0);
      current[i] = (raw[start + 1 + i] + prediction) & 255;
    }
    if (bpp === 4) hash.update(current);
    else {
      for (let x = 0; x < width; x++) { current.copy(rgba, x * 4, x * 3, x * 3 + 3); rgba[x * 4 + 3] = 255; }
      hash.update(rgba);
    }
    [prev, current] = [current, prev];
  }
  return { width, height, hash: hash.digest('hex') };
}
(async () => {
  if (!process.env.ZLI_BASELINE) throw new Error('请通过ZLI_BASELINE指定上一版脚本路径。');
  const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : { channel: 'chromium' }), headless: true });
  const records = [];
  try {
    for (const cssHeight of [4000, 17000]) {
      const results = [];
      for (const [name, file] of [['before', process.env.ZLI_BASELINE], ['after', path.join(root, 'zhihu-long-image.user.js')]]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.route('https://www.zhihu.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><h1 class="QuestionHeader-title">PNG性能与像素一致性测试</h1><main class="Question-main"><div class="QuestionAnswers-answers"><article class="AnswerItem" data-aid="606"><div class="AuthorInfo"><span class="AuthorInfo-name">测试作者</span></div><div class="RichContent-inner"><div class="RichText"><p>文字测试，确认没有缩小图片或降低分辨率。</p><div style="height:${cssHeight}px;background:linear-gradient(#d04030,#3070b0)">彩色渐变内容</div><p>末尾 END-606</p></div></div></article></div></main>` }));
        await page.goto('https://www.zhihu.com/question/123456');
        await page.evaluate(() => {
          const RealDate = Date;
          window.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-11-26T00:00:00Z'])); } static now() { return RealDate.now(); } };
          window.pngCaptureCalls = 0;
        });
        await page.addScriptTag({ path: path.join(root, 'extension/vendor/html2canvas.min.js') });
        await page.evaluate(() => {
          const capture = window.html2canvas;
          window.html2canvas = (...args) => { window.pngCaptureCalls++; return capture(...args); };
        });
        const source = fs.readFileSync(file, 'utf8').replace('WIDTH: 900,', 'WIDTH: 400,');
        await page.addScriptTag({ content: source });
        const started = performance.now();
        await page.getByRole('button', { name: '导出此回答' }).click();
        await page.locator('#zli-preview').waitFor({ timeout: 120000 });
        const ms = performance.now() - started;
        const calls = await page.evaluate(() => window.pngCaptureCalls);
        const event = page.waitForEvent('download'); await page.getByRole('link', { name: '下载 PNG 长图' }).click();
        const download = await event;
        const target = path.join(output, `png-${cssHeight}-${name}.png`); await download.saveAs(target);
        const data = fs.readFileSync(target);
        results.push({ name, ms: Math.round(ms), calls, bytes: data.length, ...pixelHash(data) });
        await page.close();
      }
      assert.equal(results[0].width, results[1].width);
      assert.equal(results[0].height, results[1].height);
      assert.equal(results[0].hash, results[1].hash, '新旧版本的全部RGBA像素应相同');
      assert.ok(results[1].calls < results[0].calls, '截图解析次数应减少');
      records.push({ cssHeight, results });
    }
    fs.writeFileSync(path.join(output, 'png-performance.json'), JSON.stringify(records, null, 2));
    console.log(JSON.stringify(records));
    console.log('PASS: 新旧PNG独立解码后全部像素一致，截图解析次数减少；耗时仅代表本机合成页面。');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
