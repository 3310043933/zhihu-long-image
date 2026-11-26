/* jasonLi · MIT. 油猴图片读取接口到 Manifest V3 消息接口的适配。 */
(() => {
  'use strict';
  const defaults = { ANSWER_COUNT: 10, SCALE: 2, FORMAT: 'png', PDF_KEEP_IMAGES: true, PANEL_COLLAPSED: false };
  globalThis.ZLI_READY = chrome.storage.local.get(defaults).then(settings => {
    globalThis.ZLI_PLATFORM_SETTINGS = {
      ANSWER_COUNT: Number.isInteger(settings.ANSWER_COUNT) && settings.ANSWER_COUNT > 0 ? settings.ANSWER_COUNT : 10,
      SCALE: [1, 2, 3, 4].includes(settings.SCALE) ? settings.SCALE : 2,
      FORMAT: ['png', 'svg', 'html', 'pdf', 'webp'].includes(settings.FORMAT) ? settings.FORMAT : 'png',
      PDF_KEEP_IMAGES: typeof settings.PDF_KEEP_IMAGES === 'boolean' ? settings.PDF_KEEP_IMAGES : true,
      PANEL_COLLAPSED: typeof settings.PANEL_COLLAPSED === 'boolean' ? settings.PANEL_COLLAPSED : false,
    };
  }).catch(() => { globalThis.ZLI_PLATFORM_SETTINGS = defaults; });
  globalThis.ZLI_SAVE_SETTINGS = settings => chrome.storage.local.set({
    ANSWER_COUNT: settings.ANSWER_COUNT, SCALE: settings.SCALE, FORMAT: settings.FORMAT, PDF_KEEP_IMAGES: settings.PDF_KEEP_IMAGES, PANEL_COLLAPSED: settings.PANEL_COLLAPSED,
  });

  globalThis.GM_xmlhttpRequest = options => {
    chrome.runtime.sendMessage({ type: 'ZLI_FETCH_IMAGE', url: options.url }).then(result => {
      if (!result?.ok) throw new Error(result?.error || '图片读取失败');
      const binary = atob(result.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      options.onload?.({ status: 200, response: new Blob([bytes], { type: result.mime }) });
    }).catch(error => options.onerror?.(error));
  };
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== 'ZLI_SHOW_PANEL') return;
    const panel = document.getElementById('zli-panel');
    if (panel) {
      panel.dispatchEvent(new Event('zli-show-panel'));
    }
  });
})();
