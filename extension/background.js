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
  if (['ZLI_FETCH_MEDIA', 'ZLI_ABORT_MEDIA'].includes(message?.type)) return handleMediaMessage(message, sender, sendResponse);
  if (message?.type !== 'ZLI_FETCH_IMAGE') return false;
  if (!allowedSender(sender)) { sendResponse({ ok: false, error: '无效来源。' }); return false; }
  fetchImageData(message.url).then(sendResponse, error => sendResponse({ ok: false, error: error.message || '图片读取失败' }));
  return true;
});

const mediaDownloads = new Map();
function allowedMediaURL(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && /(^|\.)(zhihu\.com|zhimg\.com|vzuu\.com)$/.test(url.hostname);
  } catch { return false; }
}
async function fetchMediaData(url, controller, progress = () => {}) {
  if (!allowedMediaURL(url)) throw new Error('只允许读取HTTPS知乎媒体域名。');
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error(`音视频响应 ${response.status}`);
    let mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!/^(audio|video)\//.test(mime) && mime !== 'application/octet-stream') throw new Error('响应不是音视频文件，分段/加密播放流暂不支持。');
    const limit = 32 * 1024 * 1024, total = Number(response.headers.get('content-length')) || 0;
    if (total > limit) throw new Error('单个音视频超过32MB。');
    const reader = response.body.getReader(), chunks = []; let length = 0, last = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.length; if (length > limit) throw new Error('单个音视频超过32MB。');
        chunks.push(value);
        if (Date.now() - last > 300) { progress(length, total); last = Date.now(); }
      }
    } finally { await reader.cancel().catch(() => {}); }
    const data = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    if (mime === 'application/octet-stream') {
      if (String.fromCharCode(...data.subarray(4, 8)) === 'ftyp') mime = 'video/mp4';
      else if (String.fromCharCode(...data.subarray(0, 3)) === 'ID3' || (data[0] === 255 && (data[1] & 0xe0) === 0xe0)) mime = 'audio/mpeg';
      else if (String.fromCharCode(...data.subarray(0, 4)) === 'OggS') mime = 'audio/ogg';
      else throw new Error('无法识别媒体文件类型。');
    }
    const strings = [];
    for (let i = 0; i < data.length; i += 0x8000) strings.push(String.fromCharCode(...data.subarray(i, i + 0x8000)));
    return { ok: true, mime, base64: btoa(strings.join('')) };
  } finally { clearTimeout(timer); }
}
function handleMediaMessage(message, sender, sendResponse) {
  if (!['ZLI_FETCH_MEDIA', 'ZLI_ABORT_MEDIA'].includes(message?.type)) return false;
  if (!allowedSender(sender) || !Number.isInteger(sender.tab?.id) || !/^[\w-]{1,80}$/.test(message.requestId || '')) { sendResponse({ ok:false, error:'无效来源或请求标识。' }); return false; }
  const key = `${sender.tab.id}:${message.requestId}`;
  if (message.type === 'ZLI_ABORT_MEDIA') { mediaDownloads.get(key)?.abort(); sendResponse({ok:true}); return false; }
  if (mediaDownloads.has(key) || mediaDownloads.size >= 4) { sendResponse({ok:false,error:'媒体下载任务过多。'}); return false; }
  const controller = new AbortController(); mediaDownloads.set(key, controller);
  fetchMediaData(message.url, controller, (loaded, total) => {
    chrome.tabs.sendMessage(sender.tab.id, {type:'ZLI_MEDIA_PROGRESS',requestId:message.requestId,loaded,total}, {frameId:0}).catch(() => {});
  }).then(sendResponse, error => sendResponse({ok:false,error:error.message || '音视频下载失败'})).finally(() => mediaDownloads.delete(key));
  return true;
}
