// 可选真实浏览器检查：超长WebP的分图、缩小、PNG替代与取消。
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
    const errors = [];
    page.on('console', message => { if (message.type() === 'error' && message.text().includes('[知乎长图]')) errors.push(message.text()); });
    await page.route('https://www.zhihu.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><h1 class="QuestionHeader-title">超长WebP处理测试</h1><main class="Question-main"><div class="QuestionAnswers-answers"><article class="AnswerItem" data-aid="404"><div class="AuthorInfo"><span class="AuthorInfo-name">测试作者</span></div><div class="RichContent-inner"><div class="RichText"><p>开头标记 START-404</p><div style="height:8500px;background:linear-gradient(#fff,#eff6ff)">超长正文占位。</div><p>末尾标记 END-404</p></div></div></article></div></main>' }));
    await page.goto('https://www.zhihu.com/question/123456');
    for (const file of ['extension/vendor/html2canvas.min.js', 'extension/vendor/jspdf.umd.min.js', 'zhihu-long-image.user.js']) await page.addScriptTag({ path: path.join(root, file) });
    await page.locator('#zli-format').selectOption('webp');
    async function begin() {
      await page.getByRole('button', { name: '导出此回答' }).click();
      await page.getByRole('alertdialog').waitFor();
      assert.equal(await page.locator('#zli-progress').getAttribute('data-state'), 'waiting');
    }
    await begin();
    await page.getByRole('alertdialog').screenshot({ path: path.join(output, 'webp-overflow-options.png') });
    await page.getByRole('alertdialog').getByRole('button', { name: '取消，返回页面' }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('#zli-panel p:last-child')?.textContent?.includes('已取消') || !document.querySelector('.zli-single-export').disabled);
    assert.equal(await page.locator('#zli-preview').count(), 0);
    assert.equal(await page.locator('#zli-stage').count(), 0);
    assert.equal(await page.locator('#zli-progress').getAttribute('data-state'), 'cancelled');
    assert.equal(await page.locator('#zli-progress progress').getAttribute('value'), '0');
    for (const choice of ['保持清晰度，导出多张WebP（推荐）', /^缩小为单张WebP/, '本次改用一张高清PNG']) {
      await begin();
      await page.getByRole('alertdialog').getByRole('button', { name: choice }).click();
      await page.locator('#zli-preview').waitFor({ timeout: 120000 });
      const links = page.locator('#zli-preview a.zli-download');
      const count = await links.count();
      const metadata = await page.evaluate(async () => {
        const files = [];
        for (const link of document.querySelectorAll('#zli-preview a.zli-download')) {
          const blob = await (await fetch(link.href)).blob();
          const image = new Image(); image.src = link.href; await image.decode();
          files.push({ mime: blob.type, width: image.naturalWidth, height: image.naturalHeight, name: link.download });
        }
        return files;
      });
      if (typeof choice === 'string' && choice.startsWith('保持')) {
        assert.ok(count >= 2);
        assert.ok(metadata.every(file => file.mime === 'image/webp' && file.width === 1800 && file.height <= 16383 && file.name.endsWith('.webp')));
      } else if (choice instanceof RegExp) {
        assert.equal(count, 1); assert.equal(metadata[0].mime, 'image/webp');
        assert.ok(metadata[0].width < 1800 && metadata[0].height <= 16383);
        assert.match(await page.locator('#zli-preview').innerText(), /按你的选择缩小/);
      } else {
        assert.equal(count, 1); assert.equal(metadata[0].mime, 'image/png');
        assert.equal(metadata[0].width, 1800); assert.ok(metadata[0].height > 16383);
        assert.ok(metadata[0].name.endsWith('.png'));
      }
      assert.equal(await page.locator('#zli-format').inputValue(), 'webp', '一次性选择不能改写WebP偏好');
      await page.getByRole('button', { name: '关闭', exact: true }).click();
    }
    assert.deepEqual(errors, [], '预期超限和取消不应记录为错误');
    console.log('PASS: 超长WebP显示处理对话框；分图保持1800宽、单张缩小后尺寸合规、一次性PNG保留超长高清、取消清理、偏好不变且不记录错误。');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
