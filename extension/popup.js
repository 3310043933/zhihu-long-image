'use strict';
const count = document.getElementById('count');
const scale = document.getElementById('scale');
const status = document.getElementById('status');
document.getElementById('installation').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('install.html') }));
document.getElementById('updates').addEventListener('click', async () => {
  try {
    const info = await (await fetch(chrome.runtime.getURL('release-info.json'))).json();
    const valid = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/releases\/latest$/.test(info.release || '');
    await chrome.tabs.create({ url: valid ? info.release : chrome.runtime.getURL('install.html') });
  } catch { status.textContent = '无法读取发布信息，请打开安装与更新指南。'; }
});
chrome.storage.local.get({ ANSWER_COUNT: 10, SCALE: 2 }).then(settings => {
  count.value = settings.ANSWER_COUNT;
  scale.value = settings.SCALE;
}).catch(() => { status.textContent = '设置读取失败，请重试。'; });
document.getElementById('settings').addEventListener('submit', async event => {
  event.preventDefault();
  const value = Number(count.value);
  if (!Number.isSafeInteger(value) || value < 1) { status.textContent = '回答数请输入正整数。'; return; }
  try {
    await chrome.storage.local.set({ ANSWER_COUNT: value, SCALE: Number(scale.value) });
    status.textContent = '已保存。刷新知乎页面后生效。';
  } catch { status.textContent = '保存失败，请重试。'; }
});
document.getElementById('show').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!/^https:\/\/www\.zhihu\.com\/question\/\d+(?:\/answer\/\d+)?\/?(?:[?#].*)?$/.test(tab?.url || '')) {
      status.textContent = '请先打开知乎提问的回答列表页面。'; return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: 'ZLI_SHOW_PANEL' });
    window.close();
  } catch { status.textContent = '请刷新知乎页面，让扩展加载后再试。'; }
});
