'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.ZLI_TEST_OUTPUT || path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : { channel: 'chromium' }), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(root, 'docs/install.html')).href);
    assert.equal(await page.locator('#install-script').getAttribute('aria-disabled'), 'true');
    await page.locator('#repo').fill('https://evil.example/owner/repo');
    await page.getByRole('button', { name: '生成安装链接' }).click();
    assert.match(await page.getByRole('status').innerText(), /请输入/);
    await page.locator('#repo').fill('https://github.com/sample-owner/zhihu-long-image');
    await page.getByRole('button', { name: '生成安装链接' }).click();
    assert.equal(await page.locator('#install-script').getAttribute('href'), 'https://github.com/sample-owner/zhihu-long-image/releases/latest/download/zhihu-long-image.user.js');
    assert.ok((await page.locator('#install-extension').getAttribute('href')).endsWith('/zhihu-long-image-extension.zip'));
    assert.ok((await page.locator('#source').getAttribute('href')).endsWith('/zhihu-long-image-source.zip'));
    await page.screenshot({ path: path.join(output, 'install-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'install-mobile.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '手机宽度不应出现横向溢出');
    await page.goto(pathToFileURL(path.join(root, 'extension/install.html')).href);
    assert.ok(await page.getByRole('heading', { name: '油猴脚本', exact: true }).isVisible());
    assert.deepEqual(errors, []);
    console.log('PASS: 安装页离线打开、非法仓库拒绝、稳定下载链接、手机排版、扩展内指南。未访问或发布远程仓库。');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
