// 可选真实浏览器检查：需要另行安装 playwright 及 Chromium，不属于零依赖 npm test。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const artifacts = process.env.ZLI_TEST_OUTPUT || path.join(root, 'test-results');
fs.mkdirSync(artifacts, { recursive: true });
const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:0;background:#f4f5f7;color:#222;font:17px/1.8 sans-serif}.Question-main,.QuestionHeader-title{width:700px;margin:30px auto}.AnswerItem{background:white;padding:24px;margin-bottom:20px}.RichContent-inner{max-height:180px;overflow:hidden}.expanded .RichContent-inner{max-height:none}p{margin-bottom:20px}
</style></head><body><h1 class="QuestionHeader-title">长图导出测试：文字、图片和第二条回答</h1><div class="QuestionHeader-detail"><div class="RichText"><p>问题描述 QUESTION-DESCRIPTION：单条导出必须保留这段背景。</p></div></div><main class="Question-main"><div class="QuestionAnswers-answers">
<article class="AnswerItem" data-aid="101"><div class="ContentItem-meta"><div class="AuthorInfo" style="display:flex;align-items:center"><div class="AuthorInfo-name">测试作者甲</div><button class="FollowButton">已关注</button></div></div><div class="RichContent-inner"><div class="RichText">${Array.from({ length: 12 }, (_, i) => `<p>第${i + 1}段：知乎回答长图测试。文字应清晰可读，段落不能丢失。保留作者、正文和来源链接。<strong>这是粗体文字。</strong> This is an English text sample.</p>`).join('')}<p>第一条回答末尾标记 END-101。</p></div></div><button onclick="this.parentElement.classList.add('expanded');this.remove()">阅读全文</button></article>
<article class="AnswerItem" data-aid="102"><div class="ContentItem-meta"><div class="AuthorInfo" style="display:flex;align-items:center"><div class="AuthorInfo-name">测试作者乙</div><button class="FollowButton">已关注</button></div></div><div class="RichContent-inner" style="max-height:none"><div class="RichText"><p>第二条回答，包含列表与代码。</p><ul><li>按当前顺序</li><li>保留完整正文</li></ul><pre>const x = 2;\nconsole.log(x);</pre><img alt="测试图片" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="><p>第二条回答末尾标记 END-102。</p></div></div></article>
</div></main></body></html>`;

function inspectPNG(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  const compressed = [];
  for (let pos = 8; pos < buffer.length;) {
    const length = buffer.readUInt32BE(pos);
    if (buffer.toString('ascii', pos + 4, pos + 8) === 'IDAT') compressed.push(buffer.subarray(pos + 8, pos + 8 + length));
    pos += length + 12;
  }
  assert.equal(zlib.inflateSync(Buffer.concat(compressed)).length, (width * 4 + 1) * height);
  return { width, height };
}

(async () => {
  const extension = path.join(root, 'extension');
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'zli-smoke-')), {
    ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : { channel: 'chromium' }),
    headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionID = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionID}/popup.html`);
    await popup.locator('#count').fill('3');
    await popup.locator('#scale').selectOption('2');
    await popup.getByRole('button', { name: '保存默认设置' }).click();
    await popup.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    await popup.locator('body').screenshot({ path: path.join(artifacts, 'extension-settings.png') });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://www.zhihu.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
    await page.goto('https://www.zhihu.com/question/123456');
    await page.locator('#zli-panel').waitFor();
    await page.getByRole('button', { name: '收起长图工具', exact: true }).click();
    await page.locator('#zli-panel').waitFor({ state: 'hidden' });
    await page.locator('#zli-launcher').waitFor();
    await page.locator('#zli-launcher').screenshot({ path: path.join(artifacts, 'panel-collapsed.png') });
    await worker.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        if ((await chrome.storage.local.get('PANEL_COLLAPSED')).PANEL_COLLAPSED === true) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('收起状态未保存');
    });
    await page.reload();
    await page.locator('#zli-launcher').waitFor();
    assert.equal(await page.locator('#zli-panel').isVisible(), false, '刷新后应保持收起');
    await page.getByRole('button', { name: '展开长图工具', exact: true }).click();
    await page.locator('#zli-panel').waitFor();
    await page.evaluate(() => {
      window.zliCapturedStages = [];
      window.zliProgressStages = [];
      new MutationObserver(records => {
        for (const record of records) for (const item of record.addedNodes) {
          if (item.id === 'zli-stage') window.zliCapturedStages.push(item.innerText);
        }
      }).observe(document.body, { childList: true });
      new MutationObserver(records => {
        for (const record of records) if (record.attributeName === 'data-state') {
          if (record.oldValue) window.zliProgressStages.push(record.oldValue);
          window.zliProgressStages.push(record.target.dataset.state);
        }
      }).observe(document.getElementById('zli-progress'), { attributes: true, attributeOldValue: true });
    });
    assert.equal(await page.getByRole('button', { name: '导出此回答', exact: true }).count(), 2);
    assert.ok(await page.locator('.zli-single-export').first().evaluate(el => el.previousElementSibling.classList.contains('FollowButton')));
    const buttonStyles = await page.locator('.zli-single-export').first().evaluate(el => {
      const follow = el.previousElementSibling;
      const a = getComputedStyle(el), b = getComputedStyle(follow);
      return { height: a.height, followHeight: b.height, color: a.color, followColor: b.color,
        background: a.backgroundColor, followBackground: b.backgroundColor,
        gap: el.getBoundingClientRect().left - follow.getBoundingClientRect().right };
    });
    assert.equal(buttonStyles.height, buttonStyles.followHeight);
    assert.equal(buttonStyles.color, buttonStyles.followColor);
    assert.equal(buttonStyles.background, buttonStyles.followBackground);
    assert.ok(buttonStyles.gap >= 9 && buttonStyles.gap <= 11);
    assert.equal(await page.locator('#zli-answer-count').inputValue(), '3', '扩展设置须传入核心');
    await page.getByRole('spinbutton', { name: '截取前几条回答' }).fill('2');
    assert.equal(await page.locator('#zli-panel .zli-title input').inputValue(), '2');
    await page.locator('#zli-panel').screenshot({ path: path.join(artifacts, 'panel-input.png') });
    await page.locator('#zli-panel').getByRole('button', { name: '单张高清长图' }).click();
    await page.getByRole('button', { name: '收起长图工具', exact: true }).click();
    await page.locator('#zli-launcher').waitFor();
    await page.locator('#zli-preview').waitFor({ timeout: 120000 });
    assert.equal(await page.locator('#zli-progress').getAttribute('data-state'), 'ready');
    assert.equal(await page.locator('#zli-progress progress').getAttribute('value'), '100');
    const stages = await page.evaluate(() => window.zliProgressStages);
    assert.ok(stages.includes('collect') && stages.includes('images') && stages.includes('render') && stages.includes('ready'));
    assert.match(await page.locator('#zli-progress [data-role=time]').innerText(), /总耗时/);
    assert.match(await page.locator('#zli-preview').innerText(), /共 2 条回答，1 张 PNG/);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载 PNG 长图' }).click();
    const download = await downloadEvent;
    const output = path.join(artifacts, 'extension-export.png');
    await download.saveAs(output);
    const size = inspectPNG(fs.readFileSync(output));
    assert.equal(size.width, 1800);
    assert.ok(size.height > 1000);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(artifacts, 'extension-result.png') });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '展开长图工具', exact: true }).click();
    await page.locator('#zli-panel').screenshot({ path: path.join(artifacts, 'progress-complete.png') });
    const secondAnswer = page.locator('.AnswerItem[data-aid="102"]');
    await secondAnswer.screenshot({ path: path.join(artifacts, 'single-answer-button.png') });
    await secondAnswer.getByRole('button', { name: '导出此回答', exact: true }).click();
    await page.locator('#zli-preview').waitFor({ timeout: 120000 });
    assert.match(await page.locator('#zli-preview').innerText(), /共 1 条回答，1 张 PNG/);
    const captured = await page.evaluate(() => window.zliCapturedStages.at(-1));
    assert.match(captured, /长图导出测试/);
    assert.match(captured, /QUESTION-DESCRIPTION/);
    assert.match(captured, /测试作者乙/);
    assert.match(captured, /END-102/);
    assert.ok(!captured.includes('END-101') && !captured.includes('测试作者甲'), '只应包含所选第二条回答');
    const singleDownloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载 PNG 长图' }).click();
    const singleDownload = await singleDownloadEvent;
    assert.match(singleDownload.suggestedFilename(), /回答102_含问题/);
    await singleDownload.saveAs(path.join(artifacts, 'single-answer-export.png'));
    inspectPNG(fs.readFileSync(path.join(artifacts, 'single-answer-export.png')));
    await page.screenshot({ path: path.join(artifacts, 'single-answer-result.png') });

    for (const format of ['html', 'svg', 'pdf', 'webp']) {
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('combobox', { name: '导出格式', exact: true }).selectOption(format);
      if (format === 'pdf') await page.locator('#zli-panel').getByRole('button', { name: '导出 PDF', exact: true }).click();
      else await secondAnswer.getByRole('button', { name: '导出此回答', exact: true }).click();
      await page.locator('#zli-preview').waitFor({ timeout: 120000 });
      assert.match(await page.locator('#zli-preview').innerText(), new RegExp(`共 ${format === 'pdf' ? 2 : 1} 条回答，1 (个|张) ${format.toUpperCase()}`));
      const event = page.waitForEvent('download');
      await page.locator('#zli-preview a.zli-download').click();
      const file = await event;
      assert.ok(file.suggestedFilename().endsWith(`.${format}`));
      const target = path.join(artifacts, `single-answer-export.${format}`);
      await file.saveAs(target);
      const data = fs.readFileSync(target);
      if (format === 'html' || format === 'svg') {
        const text = data.toString('utf8');
        assert.ok(text.includes('QUESTION-DESCRIPTION') && text.includes('END-102') && !text.includes('END-101'));
        assert.ok(!/<script\b/i.test(text) && !/\son[a-z]+=/i.test(text), '导出静态文件不应保留脚本和事件');
        const offline = await context.newPage();
        if (format === 'html') {
          await offline.setContent(text);
          assert.match(await offline.locator('#zli-stage').innerText(), /END-102/);
          assert.ok(await offline.locator('#zli-stage').isVisible());
        } else {
          const parsed = await offline.evaluate(xml => {
            const doc = new DOMParser().parseFromString(xml, 'image/svg+xml');
            return { error: !!doc.querySelector('parsererror'), content: doc.querySelector('foreignObject')?.textContent };
          }, text);
          assert.equal(parsed.error, false);
          assert.match(parsed.content, /END-102/);
          await offline.goto(`data:image/svg+xml;base64,${data.toString('base64')}`);
          const geometry = await offline.evaluate(() => ({
            content: document.getElementById('zli-stage').getBoundingClientRect().height,
            svg: Number(document.documentElement.getAttribute('height')),
          }));
          assert.ok(geometry.svg >= geometry.content - 1, 'SVG高度必须覆盖全部正文');
        }
        await offline.close();
      } else if (format === 'pdf') {
        assert.equal(data.subarray(0, 5).toString(), '%PDF-');
        assert.ok(data.toString('latin1').match(/\/Type \/Page\b/g).length >= 2, '长回答PDF应正确分页');
        assert.match(data.toString('latin1'), /%%EOF/);
      } else {
        assert.equal(data.toString('ascii', 0, 4), 'RIFF');
        assert.equal(data.toString('ascii', 8, 12), 'WEBP');
        const dims = await page.evaluate(async url => {
          const image = new Image(); image.src = url; await image.decode(); return [image.naturalWidth, image.naturalHeight];
        }, await page.locator('#zli-preview a').getAttribute('href'));
        assert.equal(dims[0], 1800);
      }
    }
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('combobox', { name: '导出格式', exact: true }).selectOption('html');
    await page.locator('#zli-panel').screenshot({ path: path.join(artifacts, 'format-selector.png') });

    // 页面上的修改无需点击导出就应保存；刷新及切换问题后恢复。
    await page.locator('#zli-format').selectOption('png');
    await page.getByRole('spinbutton', { name: '截取前几条回答' }).fill('7');
    await page.locator('#zli-scale').selectOption('3');
    await page.locator('#zli-format').selectOption('svg');
    await worker.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        const saved = await chrome.storage.local.get(['ANSWER_COUNT', 'SCALE', 'FORMAT']);
        if (saved.ANSWER_COUNT === 7 && saved.SCALE === 3 && saved.FORMAT === 'svg') return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('页面偏好未写入扩展存储');
    });
    await page.reload();
    await page.locator('#zli-format').waitFor();
    assert.equal(await page.locator('#zli-answer-count').inputValue(), '7');
    assert.equal(await page.locator('#zli-scale').inputValue(), '3');
    assert.equal(await page.locator('#zli-format').inputValue(), 'svg');
    await page.goto('https://www.zhihu.com/question/987654');
    await page.locator('#zli-format').waitFor();
    assert.equal(await page.locator('#zli-answer-count').inputValue(), '7');
    assert.equal(await page.locator('#zli-scale').inputValue(), '3');
    assert.equal(await page.locator('#zli-format').inputValue(), 'svg');
    await page.locator('#zli-answer-count').fill('');
    await page.locator('#zli-format').selectOption('png');
    const preserved = await worker.evaluate(() => chrome.storage.local.get('ANSWER_COUNT'));
    assert.equal(preserved.ANSWER_COUNT, 7, '清空编辑中的数量不能覆盖已保存值');

    // 单条详情页只允许导出当前回答，不能冒充前X条。
    await page.goto('https://www.zhihu.com/question/123456/answer/102');
    await page.locator('.zli-single-export').waitFor();
    assert.equal(await page.locator('.zli-single-export').count(), 1);
    assert.ok(await page.locator('#zli-panel').getByRole('button', { name: '单张高清长图' }).isDisabled());
    await page.locator('.zli-single-export').click();
    await page.locator('#zli-preview').waitFor({ timeout: 120000 });
    assert.match(await page.locator('#zli-preview').innerText(), /共 1 条回答/);
    assert.ok(await page.locator('#zli-panel').getByRole('button', { name: '单张高清长图' }).isDisabled(), '详情页完成导出后批量入口仍应禁用');

    // 单独检查油猴源文件：使用真实浏览器和真实html2canvas，GM接口仅在测试中模拟。
    const userPage = await context.newPage();
    // extension会自动注入，因此换用无扩展的独立浏览器上下文测试用户脚本。
    await userPage.close();
    const clean = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : { channel: 'chromium' }), headless: true });
    try {
      const user = await clean.newPage({ viewport: { width: 1280, height: 900 } });
      await user.addInitScript(() => {
        window.GM_getValue = (key, fallback) => JSON.parse(localStorage.getItem(`fixture-${key}`) || JSON.stringify(fallback));
        window.GM_setValue = (key, value) => localStorage.setItem(`fixture-${key}`, JSON.stringify(value));
      });
      await user.route('https://www.zhihu.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
      await user.goto('https://www.zhihu.com/question/123456');
      await user.addScriptTag({ path: path.join(extension, 'vendor/html2canvas.min.js') });
      await user.addScriptTag({ path: path.join(extension, 'vendor/jspdf.umd.min.js') });
      await user.addScriptTag({ path: path.join(root, 'zhihu-long-image.user.js') });
      await user.locator('#zli-answer-count').fill('2');
      await user.locator('#zli-panel').getByRole('button', { name: '单张高清长图' }).click();
      await user.locator('#zli-preview').waitFor({ timeout: 120000 });
      assert.match(await user.locator('#zli-preview').innerText(), /共 2 条回答，1 张 PNG/);
      await user.getByRole('button', { name: '关闭', exact: true }).click();
      await user.locator('#zli-answer-count').fill('9');
      await user.locator('#zli-scale').selectOption('4');
      await user.locator('#zli-format').selectOption('html');
      await user.reload();
      await user.addScriptTag({ path: path.join(extension, 'vendor/html2canvas.min.js') });
      await user.addScriptTag({ path: path.join(extension, 'vendor/jspdf.umd.min.js') });
      await user.addScriptTag({ path: path.join(root, 'zhihu-long-image.user.js') });
      assert.equal(await user.locator('#zli-answer-count').inputValue(), '9');
      assert.equal(await user.locator('#zli-scale').inputValue(), '4');
      assert.equal(await user.locator('#zli-format').inputValue(), 'html');
    } finally { await clean.close(); }
    console.log(`PASS: 五种格式及单条/详情页；扩展无需导出即保存、刷新及跨问题恢复、编辑空值保护；油猴GM存储模拟及刷新恢复。模拟知乎页面。`);
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
