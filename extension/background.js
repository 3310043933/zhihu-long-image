/* jasonLi · MIT. 只接受来自知乎主站顶层页面的知乎图片读取请求。 */
'use strict';

function allowedImageURL(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    return url.hostname === 'zhimg.com' || url.hostname.endsWith('.zhimg.com');
  } catch { return false; }
}

function allowedSender(sender) {
  try {
    return sender.id === chrome.runtime.id && sender.frameId === 0 && new URL(sender.url).origin === 'https://www.zhihu.com';
  } catch { return false; }
}

async function fetchImageData(url) {
  if (!allowedImageURL(url)) throw new Error('只允许读取 HTTPS 知乎图片。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // 不携带账号 Cookie，不跟随到任意第三方域名。
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error(`图片响应 ${response.status}`);
    const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!/^image\/(jpeg|png|gif|webp|avif|bmp|svg\+xml)$/.test(mime)) throw new Error('响应不是支持的图片。');
    const maxBytes = 20 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('单张图片超过20MB。');
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxBytes) throw new Error('单张图片超过20MB。');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    const strings = [];
    for (let i = 0; i < data.length; i += 0x8000) strings.push(String.fromCharCode(...data.subarray(i, i + 0x8000)));
    return { ok: true, mime, base64: btoa(strings.join('')) };
  } finally { clearTimeout(timer); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ZLI_FETCH_IMAGE') return false;
  if (!allowedSender(sender)) { sendResponse({ ok: false, error: '无效来源。' }); return false; }
  fetchImageData(message.url).then(sendResponse, error => sendResponse({ ok: false, error: error.message || '图片读取失败' }));
  return true;
});
