// 可选浏览器检查：当前图片来源、懒加载透明度及PNG/WebP颜色采样。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.ZLI_TEST_OUTPUT || path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : { channel: 'chromium' }), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('https://www.zhihu.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><style>.lazy-photo{opacity:.55;transition:opacity 2s}.Question-main{background:#fff}.RichText img{display:block}</style><h1 class="QuestionHeader-title">导出图片颜色测试</h1><main class="Question-main"><div class="QuestionAnswers-answers"><article class="AnswerItem" data-aid="505"><div class="AuthorInfo"><span class="AuthorInfo-name">测试作者</span></div><div class="RichContent-inner"><div class="RichText"></div></div></article></div></main>' }));
    await page.goto('https://www.zhihu.com/question/123456');
    const expected = await page.evaluate(async () => {
      const colors = ['#242424', '#c04030', '#3080b0', '#e0c080'];
      function chart(faded) {
        const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 100;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 100);
        ctx.globalAlpha = faded ? .6 : 1;
        colors.forEach((color, i) => { ctx.fillStyle = color; ctx.fillRect(i * 100, 0, 100, 100); });
        return canvas.toDataURL();
      }
      const normal = chart(false), faded = chart(true);
      const source = document.querySelector('.RichText');
      for (let i = 0; i < 4; i++) {
        const image = document.createElement('img');
        image.src = normal; image.alt = `色块-${i}`;
        image.setAttribute('data-original', i === 1 ? faded : normal);
        if (i === 0) { image.className = 'lazy-photo'; image.style.opacity = '1'; }
        if (i === 2) image.style.opacity = '.7'; // 真正的半透明效果也要保留，不能全部强制不透明。
        if (i === 3) {
          const placeholder = document.createElement('canvas'); placeholder.width = placeholder.height = 1;
          image.src = placeholder.toDataURL(); image.className = 'lazy-photo';
        }
        source.append(image); await image.decode();
      }
      const expected = [];
      for (const image of source.querySelectorAll('img')) {
        const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 100;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 100);
        ctx.globalAlpha = Number(getComputedStyle(image).opacity); ctx.drawImage(image, 0, 0);
        expected.push([50, 150, 250, 350].map(x => [...ctx.getImageData(x, 50, 1, 1).data].slice(0, 3)));
      }
      expected[3] = expected[0]; // 懒加载占位图在导出时应换成完整图片，不延续占位透明度。
      window.colorGeometry = [];
      new MutationObserver(records => {
        for (const record of records) for (const item of record.addedNodes) if (item.id === 'zli-stage') {
          const origin = item.getBoundingClientRect();
          window.colorGeometry = [...item.querySelectorAll('img')].map(img => {
            const box = img.getBoundingClientRect();
            return { x: box.left - origin.left, y: box.top - origin.top, width: box.width, height: box.height, opacity: getComputedStyle(img).opacity };
          });
        }
      }).observe(document.body, { childList: true });
      return expected;
    });
    for (const file of ['extension/vendor/html2canvas.min.js', 'extension/vendor/jspdf.umd.min.js', 'zhihu-long-image.user.js']) await page.addScriptTag({ path: path.join(root, file) });
    for (const format of ['png', 'webp']) {
      await page.locator('#zli-format').selectOption(format);
      await page.getByRole('button', { name: '导出此回答' }).click();
      await page.locator('#zli-preview').waitFor({ timeout: 120000 });
      const actual = await page.evaluate(async () => {
        const image = new Image(); image.src = document.querySelector('#zli-preview a').href; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return window.colorGeometry.map(box => [0.125, .375, .625, .875].map(fraction => {
          const x = Math.floor((box.x + box.width * fraction) * 2), y = Math.floor((box.y + box.height / 2) * 2);
          return [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
        }));
      });
      assert.equal(actual.length, 4);
      const tolerance = format === 'png' ? 1 : 8;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(actual[i][j][c] - expected[i][j][c]) <= tolerance,
          `${format} image${i} patch${j} channel${c}: ${actual[i][j][c]} vs ${expected[i][j][c]}`);
      }
      await page.getByRole('button', { name: '关闭', exact: true }).click();
    }
    console.log('PASS: PNG/WebP真实像素采样；不受懒加载透明度回退影响；优先当前显示的图片而非颜色不同的data-original；保留真实半透明效果。');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
