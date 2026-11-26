// 可选浏览器检查：验证真实PDF里的JPEG分页没有把两张测试照片的首尾分开。
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
    await page.route('https://www.zhihu.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><h1 class="QuestionHeader-title">PDF图片完整分页测试</h1><main class="Question-main"><div class="QuestionAnswers-answers"><article class="AnswerItem" data-aid="303"><div class="AuthorInfo"><span class="AuthorInfo-name">测试作者</span></div><div class="RichContent-inner"><div class="RichText"><div style="height:850px">正文占位，让第一张图片跨过原来的分页位置。</div></div></div></article></div></main>' }));
    await page.addInitScript(() => {
      window.GM_getValue = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
      window.GM_setValue = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    });
    await page.goto('https://www.zhihu.com/question/123456');
    await page.evaluate(() => {
      for (const [height, top, bottom] of [[600, '#f01414', '#1414f0'], [2000, '#f014f0', '#14f0f0']]) {
        const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = height;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, 400, height);
        ctx.fillStyle = top; ctx.fillRect(0, 0, 400, 40);
        ctx.fillStyle = bottom; ctx.fillRect(0, height - 40, 400, 40);
        const image = document.createElement('img'); image.src = canvas.toDataURL(); image.alt = `测试图片-${height}`;
        document.querySelector('.RichText').append(image);
      }
    });
    for (const file of ['extension/vendor/html2canvas.min.js', 'extension/vendor/jspdf.umd.min.js', 'zhihu-long-image.user.js']) await page.addScriptTag({ path: path.join(root, file) });
    assert.equal(await page.locator('.zli-pdf-options').isVisible(), false);
    await page.locator('#zli-format').selectOption('pdf');
    assert.equal(await page.locator('.zli-pdf-options').isVisible(), true);
    assert.equal(await page.locator('#zli-pdf-keep-images').isChecked(), true);
    await page.locator('#zli-panel').screenshot({ path: path.join(output, 'pdf-image-option.png') });

    async function exportPDF(keep) {
      await page.locator('#zli-pdf-keep-images').setChecked(keep);
      await page.getByRole('button', { name: '导出此回答' }).click();
      await page.locator('#zli-preview').waitFor({ timeout: 120000 });
      const event = page.waitForEvent('download'); await page.getByRole('link', { name: '下载 PDF 文件' }).click();
      const download = await event;
      const file = path.join(output, keep ? 'pdf-images-kept.pdf' : 'pdf-images-split.pdf');
      await download.saveAs(file);
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      return fs.readFileSync(file);
    }
    async function markersByPage(buffer) {
      const text = buffer.toString('latin1');
      const jpegs = [];
      const expression = /\d+ 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
      for (const match of text.matchAll(expression)) {
        if (!match[1].includes('/Subtype /Image') || !match[1].includes('/DCTDecode')) continue;
        const length = Number(match[1].match(/\/Length (\d+)/)[1]);
        const start = match.index + match[0].length;
        jpegs.push(buffer.subarray(start, start + length).toString('base64'));
      }
      assert.ok(jpegs.length >= 3);
      return page.evaluate(async images => {
        const results = [];
        for (const base64 of images) {
          const image = new Image(); image.src = `data:image/jpeg;base64,${base64}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const found = [false, false, false, false];
          for (let i = 0; i < pixels.length; i += 16) {
            const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
            if (r > 180 && g < 70 && b < 70) found[0] = true;
            if (r < 70 && g < 70 && b > 180) found[1] = true;
            if (r > 180 && g < 70 && b > 180) found[2] = true;
            if (r < 70 && g > 180 && b > 180) found[3] = true;
          }
          results.push(found);
        }
        return results;
      }, jpegs);
    }
    const kept = await markersByPage(await exportPDF(true));
    for (const [top, bottom] of [[0, 1], [2, 3]]) {
      const pagesWithTop = kept.map((markers, index) => markers[top] ? index : -1).filter(index => index >= 0);
      const pagesWithBottom = kept.map((markers, index) => markers[bottom] ? index : -1).filter(index => index >= 0);
      assert.equal(pagesWithTop.length, 1);
      assert.deepEqual(pagesWithTop, pagesWithBottom, '图片顶部及底部必须在同一PDF页，包括超高图片');
    }
    const split = await markersByPage(await exportPDF(false));
    assert.ok(split.some(markers => markers[0] && !markers[1]), '关闭后应恢复会截断第一张图片的固定分页');
    await page.reload();
    for (const file of ['extension/vendor/html2canvas.min.js', 'extension/vendor/jspdf.umd.min.js', 'zhihu-long-image.user.js']) await page.addScriptTag({ path: path.join(root, file) });
    assert.equal(await page.locator('#zli-format').inputValue(), 'pdf');
    assert.equal(await page.locator('#zli-pdf-keep-images').isChecked(), false, '选项应记住关闭状态');
    console.log('PASS: PDF选项按格式显示、普通图片整体换页、超高图片单页缩放、独立JPEG像素验证首尾同页、关闭后恢复固定分页、偏好恢复。');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
