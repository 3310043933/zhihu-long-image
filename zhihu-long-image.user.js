// ==UserScript==
// @name         知乎前 X 条回答导出长图
// @namespace    local.zhihu.long-image
// @version      1.9.0
// @author       jasonLi
// @description  导出前 X 条或单条知乎回答（含问题），支持 PNG、SVG、HTML、PDF、WebP
// @match        https://www.zhihu.com/*
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @require      https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      zhimg.com
// @connect      *.zhimg.com
// @connect      zhihu.com
// @connect      *.zhihu.com
// @connect      vzuu.com
// @connect      *.vzuu.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    ANSWER_COUNT: 10, // ★ 修改这里：截取当前排序下的前多少条回答
    QUESTION_ID: '', // 留空用于所有提问；只用于指定问题可填 '2087509207285248045'
    WIDTH: 900, // 长图排版宽度（CSS 像素）
    SCALE: 2, // 清晰度倍率：整数 1～4；不再因内容过长自动降低
    FORMAT: 'png', // png / svg / html / pdf / webp；也可以在面板下拉框选择
    HTML_INTERACTIVE: true, // HTML保留音视频入口和可展开的段落评论/回复
    PDF_KEEP_IMAGES: true, // PDF图片不跨页，超高图片等比缩小至一页内
    PANEL_COLLAPSED: false, // 面板收起状态，修改后自动记忆
    WEBP_QUALITY: 0.95, // WebP有损压缩质量；图片尺寸保持不变
    EXPORT_MODE: 'single', // single：流式编码一张高清长图；split：高清分图
    MAX_FILE_MB: 512, // 单个 PNG 压缩文件的内存保护上限；不限制为3万像素高
    MAX_HEIGHT: 30000, // 分图画布及截图块的高度上限；单张流式 PNG 不受此限
    MAX_PIXELS: 45000000, // 分图画布及截图块的像素预算
    PNG_FAST_MAX_PIXELS: 24000000, // 尺寸允许时使用浏览器原生PNG编码；设为0可禁用
    MAX_SCROLL_STEPS: 180,
    WAIT_MS: 1100,
    IMAGE_TIMEOUT_MS: 15000,
  };

  let busy = false;
  let cancelled = false;
  let activeQuestion = '';
  let lastURL = '';
  let previewURLs = [];
  let panel;
  let status;
  let start;
  let splitStart;
  let cancel;
  let countInput;
  let scaleInput;
  let formatInput;
  let formatNote;
  let htmlOptions, htmlInteractiveInput;
  let pdfOptions;
  let pdfKeepInput;
  let launcher;
  let collapseButton;
  let progressArea, progressLabel, progressBar, progressTime;
  let progressTimer;
  const taskProgress = { stage: 'idle', done: 0, total: null, started: 0, ended: 0 };
  const progressNames = { collect: '收集回答', images: '加载图片', render: '生成文件', ready: '完成，可下载', waiting: '等待你的选择', cancelled: '已取消', error: '导出失败' };

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  function elapsedText() {
    const seconds = Math.max(0, Math.floor(((taskProgress.ended || Date.now()) - taskProgress.started) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function paintProgress() {
    if (!progressArea || taskProgress.stage === 'idle') return;
    progressArea.hidden = false;
    progressArea.dataset.state = taskProgress.stage;
    const index = ['collect', 'images', 'render', 'ready'].indexOf(taskProgress.stage);
    const quantity = taskProgress.total !== null && taskProgress.total > 0 ? ` · ${taskProgress.done}/${taskProgress.total}` : '';
    progressLabel.textContent = `${index >= 0 ? `${Math.min(index + 1, 3)}/3 · ` : ''}${progressNames[taskProgress.stage]}${quantity}`;
    if (taskProgress.stage === 'ready') progressBar.value = 100;
    else if (taskProgress.stage === 'cancelled' || taskProgress.stage === 'error') progressBar.value = 0;
    else if (taskProgress.total === null || taskProgress.stage === 'waiting') progressBar.removeAttribute('value');
    else progressBar.value = taskProgress.total ? Math.min(100, taskProgress.done / taskProgress.total * 100) : 100;
    progressTime.textContent = `${taskProgress.ended ? '总耗时' : '已用时'} ${elapsedText()}${taskProgress.stage === 'render' && taskProgress.total === null ? ' · 处理中，请稍候' : ''}`;
    progressArea.querySelectorAll('[data-step]').forEach((step, i) => {
      step.dataset.active = String(i === index || (taskProgress.stage === 'waiting' && i === 2));
      step.dataset.done = String(index > i || taskProgress.stage === 'ready');
    });
    if (launcher && busy) launcher.textContent = taskProgress.total ? `${progressNames[taskProgress.stage]} ${taskProgress.done}/${taskProgress.total}` : progressNames[taskProgress.stage];
  }
  function setProgressStage(stage, total = null) {
    if (!busy) return;
    Object.assign(taskProgress, { stage, done: 0, total }); paintProgress();
  }
  function updateProgress(done, total) {
    if (!busy) return;
    if (taskProgress.stage === 'waiting') taskProgress.stage = 'render';
    Object.assign(taskProgress, { done, total }); paintProgress();
  }
  function finishProgress(stage) {
    clearInterval(progressTimer);
    Object.assign(taskProgress, { stage, ended: Date.now(), total: null }); paintProgress();
  }

  // 只读取自己的本地偏好，不把网页数据写入设置。
  const SETTINGS_KEY = 'zli-settings-v1';
  function applySavedSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    if (Number.isSafeInteger(settings.ANSWER_COUNT) && settings.ANSWER_COUNT > 0) CONFIG.ANSWER_COUNT = settings.ANSWER_COUNT;
    if ([1, 2, 3, 4].includes(settings.SCALE)) CONFIG.SCALE = settings.SCALE;
    if (['png', 'svg', 'html', 'pdf', 'webp'].includes(settings.FORMAT)) CONFIG.FORMAT = settings.FORMAT;
    if (typeof settings.HTML_INTERACTIVE === 'boolean') CONFIG.HTML_INTERACTIVE = settings.HTML_INTERACTIVE;
    if (typeof settings.PDF_KEEP_IMAGES === 'boolean') CONFIG.PDF_KEEP_IMAGES = settings.PDF_KEEP_IMAGES;
    if (typeof settings.PANEL_COLLAPSED === 'boolean') CONFIG.PANEL_COLLAPSED = settings.PANEL_COLLAPSED;
  }
  try {
    if (globalThis.ZLI_PLATFORM_SETTINGS) applySavedSettings(globalThis.ZLI_PLATFORM_SETTINGS);
    else if (typeof GM_getValue === 'function') applySavedSettings(GM_getValue(SETTINGS_KEY, {}));
  } catch (error) { console.warn('[知乎长图] 设置读取失败，使用默认值。', error); }

  function saveSettings() {
    const count = Number(countInput.value);
    // 编辑中清空、输入小数或非法数字时，保留之前的有效数量。
    if (!busy) {
      if (Number.isSafeInteger(count) && count > 0) CONFIG.ANSWER_COUNT = count;
      CONFIG.SCALE = Number(scaleInput.value);
      CONFIG.FORMAT = formatInput.value;
      CONFIG.HTML_INTERACTIVE = htmlInteractiveInput.checked;
      CONFIG.PDF_KEEP_IMAGES = pdfKeepInput.checked;
    }
    const settings = {
      ANSWER_COUNT: Number.isSafeInteger(count) && count > 0 ? count : CONFIG.ANSWER_COUNT,
      SCALE: Number(scaleInput.value), FORMAT: formatInput.value, PDF_KEEP_IMAGES: pdfKeepInput.checked,
      HTML_INTERACTIVE: htmlInteractiveInput.checked,
      PANEL_COLLAPSED: CONFIG.PANEL_COLLAPSED,
    };
    try {
      const pending = typeof globalThis.ZLI_SAVE_SETTINGS === 'function' ? globalThis.ZLI_SAVE_SETTINGS(settings)
        : typeof GM_setValue === 'function' ? GM_setValue(SETTINGS_KEY, settings) : undefined;
      if (pending?.catch) pending.catch(error => { console.warn('[知乎长图] 设置保存失败。', error); report('设置保存失败，本次仍可导出；请检查扩展是否已更新。'); });
    } catch (error) { console.warn('[知乎长图] 设置保存失败。', error); report('设置保存失败，本次仍可导出。'); }
  }

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const questionID = () => location.pathname.match(/^\/question\/(\d+)(?:\/answer\/\d+)?\/?$/)?.[1] || '';
  const detailAnswerID = () => location.pathname.match(/\/answer\/(\d+)\/?$/)?.[1] || '';
  const check = () => {
    if (cancelled) throw new Error('已取消。');
    if (questionID() !== activeQuestion) throw new Error('页面已切换，请回到目标提问后重新导出。');
  };
  const report = text => {
    status.textContent = text;
    if (launcher) { launcher.textContent = busy ? '导出中…' : '长图工具'; launcher.title = text; }
    paintProgress();
  };
  const visible = el => Boolean(el && el.getClientRects().length);
  const textOf = el => el?.textContent.trim() || '';

  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function answerID(answer) {
    let id = answer.dataset.aid || answer.dataset.answerId;
    try {
      const data = JSON.parse(answer.dataset.zaExtraModule || '{}');
      id ||= data.card?.content?.token;
    } catch { /* 某些页面的埋点字段不是 JSON。 */ }
    const link = answer.querySelector('meta[itemprop="url"], a[href*="/answer/"]');
    return String(id || (link?.content || link?.href || '').match(/\/answer\/(\d+)/)?.[1] || '');
  }

  function answerList() {
    // 只读取主回答列表，排除右侧推荐、弹窗和评论。
    const list = document.querySelector('.Question-main .QuestionAnswers-answers')
      || document.querySelector('.QuestionAnswers-answers')
      || document.querySelector('.Question-main .List')
      || document.querySelector('.QuestionAnswer-content')
      || document.querySelector('.Question-main');
    return list ? [...list.querySelectorAll('.AnswerItem')].filter(visible) : [];
  }

  async function expand(answer) {
    for (let attempt = 0; attempt < 3; attempt++) {
      check();
      const button = [...answer.querySelectorAll('button')].find(el =>
        visible(el) && /^(阅读全文|展开阅读全文|展开全部|显示全部)/.test(textOf(el)));
      if (!button) break;
      button.click();
      await pause(650);
    }
  }

  function cloneContent(content) {
    const body = content.cloneNode(true);
    const sourceImages = [...content.querySelectorAll('img')];
    const copiedImages = [...body.querySelectorAll('img')];
    // 固定图片及其容器当前的视觉状态，避免脱离知乎布局后恢复懒加载透明度/滤镜。
    const originals = [content, ...content.querySelectorAll('*')];
    const copies = [body, ...body.querySelectorAll('*')];
    const visualNodes = new Set();
    for (const image of sourceImages) for (let current = image; current && content.contains(current); current = current.parentElement) {
      visualNodes.add(current);
      if (current === content) break;
    }
    const visualStyles = new Map();
    if (typeof getComputedStyle === 'function') originals.forEach((original, index) => {
      if (!visualNodes.has(original)) return;
      const computed = getComputedStyle(original);
      visualStyles.set(copies[index], { opacity: computed.opacity, filter: computed.filter, 'mix-blend-mode': computed.mixBlendMode });
    });
    if (htmlInteractive() && typeof getComputedStyle === 'function') originals.forEach((original, index) => {
      if (original.localName !== 'span') return;
      const computed = getComputedStyle(original);
      if (/dotted|dashed/.test(computed.borderBottomStyle) && parseFloat(computed.borderBottomWidth) > 0) copies[index].classList.add('zli-original-underline');
    });
    body.classList.add('zli-body');
    body.querySelectorAll('script, style, noscript, button, .ContentItem-actions, .RichContent-actions').forEach(el => el.remove());
    const originalMedia = [...content.querySelectorAll('video, iframe, audio, canvas')];
    body.querySelectorAll('video, iframe, audio, canvas').forEach((el, index) => el.replaceWith(htmlInteractive() && /^(video|audio)$/.test(el.localName)
      ? mediaCopy(originalMedia[index]) : node('p', '【视频、音频或交互内容，请打开原回答查看】', 'zli-note')));
    copiedImages.forEach((img, index) => {
      const original = sourceImages[index];
      const lazyURL = original?.getAttribute('data-original') || original?.getAttribute('data-actualsrc') || original?.getAttribute('data-src');
      const stillPlaceholder = original && (!original.complete || !original.naturalWidth
        || (original.naturalWidth <= 16 && lazyURL && lazyURL !== original.currentSrc));
      // 尚未加载的占位图在导出副本中换成真图后，不继续保留加载时的半透明效果。
      if (stillPlaceholder && visualStyles.has(img)) visualStyles.get(img).opacity = '1';
      const displayed = original?.complete && original.naturalWidth > 16 && original.naturalHeight > 16 ? original.currentSrc || original.getAttribute('src') : '';
      // 优先保持与用户正在看的图一致，未加载/占位图才使用懒加载地址。
      let src = displayed || img.getAttribute('data-original') || img.getAttribute('data-actualsrc') || img.getAttribute('data-src') || img.getAttribute('src');
      if (src) {
        try { src = new URL(src, location.href).href; } catch { src = ''; }
      }
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.removeAttribute('loading');
      img.removeAttribute('style');
      // 导出副本不再交给站点的懒加载观察器重新选图。
      for (const attr of ['data-original', 'data-actualsrc', 'data-src']) img.removeAttribute(attr);
      if (src) img.setAttribute('src', src);
    });
    for (const [element, values] of visualStyles) {
      for (const [property, value] of Object.entries(values)) element.style.setProperty(property, value, 'important');
      element.style.setProperty('animation', 'none', 'important');
      element.style.setProperty('transition', 'none', 'important');
    }
    return body;
  }

  // 导出的交互只使用原生 media/details，不携带知乎脚本。
  const htmlInteractive = () => CONFIG.FORMAT === 'html' && CONFIG.HTML_INTERACTIVE;
  function mediaURL(raw) {
    if (!raw || typeof raw !== 'string') return '';
    try {
      if (/^data:(audio|video)\/[\w.+-]+;base64,[a-z\d+/=\s]+$/i.test(raw || '')) return raw;
      const url = new URL(raw, location.href);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function originalLink(id, text = '打开原回答') {
    const link = node('a', text);
    link.href = `https://www.zhihu.com/question/${activeQuestion}${id ? `/answer/${id}` : ''}`;
    return link;
  }
  function mediaCopy(original) {
    const box = node('figure', undefined, 'zli-media');
    const tag = original.localName === 'audio' ? 'audio' : 'video';
    const sources = [original.currentSrc, original.getAttribute('src'), ...[...original.querySelectorAll('source')].map(s => s.src)]
      .map(mediaURL).filter(Boolean);
    if (sources.length) {
      const player = node(tag); player.controls = true; player.preload = 'none';
      for (const src of [...new Set(sources)]) { const source = node('source'); source.src = src; player.append(source); }
      box.append(player, node('figcaption', sources.every(s => s.startsWith('data:')) ? '内嵌音视频' : '音视频需联网播放，链接可能过期；无法播放时请打开原回答。', 'zli-note'));
    } else box.append(node('p', '未能读取可播放地址（可能是临时 blob、加密或尚未加载的媒体），请打开原回答播放。', 'zli-note zli-incomplete'));
    box.append(originalLink(''));
    return box;
  }

  // 只允许当前知乎同源、指定资源的请求；分页链接不能改变资源或段落。
  async function readZhihuJSON(raw, options = {}) {
    check();
    const url = new URL(raw, location.href);
    if (url.origin !== 'https://www.zhihu.com' || !/^\/api\/v4\/(?:answers\/\d+|comment_v5\/(?:answers\/\d+\/segment\/root_comment|comment\/[\w-]+\/child_comment)|video\/play_info)$/.test(url.pathname)) throw new Error('无效的内容读取地址');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const cancellation = setInterval(() => { if (cancelled || questionID() !== activeQuestion) controller.abort(); }, 150);
    try {
      const response = await fetch(url.href, { ...options, credentials: 'same-origin', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error(`知乎返回 ${response.status}，可能需要登录或暂时限制访问`);
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('内容响应过大');
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw new Error('内容响应过大');
      check(); return JSON.parse(text);
    } finally { clearTimeout(timeout); clearInterval(cancellation); }
  }
  async function commentPages(url, budget) {
    const first = new URL(url, location.href), visited = new Set(), ids = new Set(), rows = [];
    let next = first.href, incomplete = '';
    try {
      while (next) {
        check();
        if (visited.has(next) || visited.size >= 50 || budget.remaining-- <= 0) throw new Error('达到读取上限或分页重复');
        visited.add(next);
        const current = new URL(next, first);
        if (current.origin !== first.origin || current.pathname !== first.pathname || current.searchParams.get('segment_id') !== first.searchParams.get('segment_id')) throw new Error('分页地址不匹配');
        const page = await readZhihuJSON(current.href);
        if (!Array.isArray(page.data)) throw new Error('评论响应结构不受支持');
        let added = 0;
        for (const row of page.data) {
          const id = String(row.id || '');
          if (!id || ids.has(id)) continue;
          ids.add(id); rows.push(row); added++;
        }
        if (page.paging?.is_end === true) break;
        if (!page.paging?.next || !added) throw new Error('分页未完整返回');
        next = new URL(page.paging.next, first).href;
        await pause(180);
      }
    } catch (error) { check(); incomplete = error.message || '读取失败'; }
    return { rows, incomplete };
  }
  function commentElement(comment) {
    const entry = node('div', undefined, 'zli-comment');
    const author = comment.author?.member || comment.author;
    const reply = comment.reply_to_author?.member || comment.reply_to_author;
    const date = Number(comment.created_time);
    entry.append(node('div', `${author?.name || '匿名用户'}${reply?.name ? ` 回复 ${reply.name}` : ''}${date > 0 && Number.isFinite(date) ? ` · ${new Date(date * 1000).toLocaleString()}` : ''}`, 'zli-meta'));
    // 评论内容通过惰性template解析，仅复制文本/排版/链接；不激活任何外部资源或事件。
    const template = document.createElement('template'); template.innerHTML = String(comment.content || '');
    const copy = (from, to) => {
      for (const child of from.childNodes) {
        if (child.nodeType === 3) { to.append(document.createTextNode(child.textContent)); continue; }
        if (child.nodeType !== 1 || /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|SVG|MATH|FORM)$/.test(child.tagName)) continue;
        const tag = child.localName;
        if (tag === 'img') { to.append(document.createTextNode(child.getAttribute('alt') || '[图片]')); continue; }
        const target = node(/^(p|br|strong|b|em|i|u|s|blockquote|ul|ol|li|code|pre|a)$/.test(tag) ? tag : 'span');
        if (tag === 'a') { try { const url = new URL(child.getAttribute('href'), location.href); if (/^https?:$/.test(url.protocol)) target.href = url.href; } catch { /* 无效链接 */ } }
        copy(child, target); to.append(target);
      }
    };
    copy(template.content, entry);
    return entry;
  }
  function segmentRecords(value, records, depth = 0, collection = false) {
    if (!value || typeof value !== 'object' || depth > 10 || records.size >= 100) return;
    const id = value.segment_id ?? value.segmentId ?? value.seg_id ?? value.segId ?? (collection && value.position ? value.id : undefined);
    if (id && /^[\w-]{1,160}$/.test(String(id))) records.set(String(id), { ...records.get(String(id)), id: String(id), text: String(value.content || value.text || records.get(String(id))?.text || ''), position: value.position });
    for (const [key, child] of Object.entries(value).slice(0, 1000)) if (typeof child === 'object') segmentRecords(child, records, depth + 1, collection || /segments|annotations/i.test(key));
  }
  function markSegment(body, record) {
    if (record.mark) return record.mark;
    let position = record.position;
    try { if (typeof position === 'string') position = JSON.parse(position); } catch { return null; }
    if (!position?.start || !position?.end) return null;
    const paragraphs = [...body.querySelectorAll('[data-pid]')];
    const start = paragraphs.find(p => p.getAttribute('data-pid') === String(position.start.paragraph_id));
    const end = paragraphs.find(p => p.getAttribute('data-pid') === String(position.end.paragraph_id));
    if (!start || !end || !Number.isSafeInteger(position.start.offset) || !Number.isSafeInteger(position.end.offset)) return null;
    const point = (paragraph, offset) => {
      if (offset < 0) return null;
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (offset <= text.length) return [text, offset];
        offset -= text.length;
      }
      return null;
    };
    const a = point(start, position.start.offset), b = point(end, position.end.offset);
    if (!a || !b) return null;
    try {
      const range = document.createRange(); range.setStart(...a); range.setEnd(...b);
      // 仅给完整对应的原文加链接标记，位置失效时仍在回答末尾保留评论。
      if (!range.toString() || (record.text && range.toString() !== record.text)) return null;
      const mark = node('span'); mark.append(range.extractContents()); range.insertNode(mark); return mark;
    } catch { return null; }
  }
  async function enrichHTMLInteractions(answer, item) {
    if (!htmlInteractive()) return;
    const aid = answerID(answer), body = item.querySelector('.zli-body');
    if (!body) return;
    body.querySelectorAll('.zli-media > a').forEach(link => { link.href = originalLink(aid).href; });
    // 知乎视频卡片尚未创建video时，通过播放信息接口读取地址；不请求视频文件本身。
    for (const card of [...body.querySelectorAll('a.video-box, a[data-video-id], a[href*="zhihu.com/video/"]')]) {
      check();
      const id = card.getAttribute('data-video-id') || (card.getAttribute('href') || '').match(/\/video\/(\d+)/)?.[1];
      if (!/^\d+$/.test(id || '') || !aid) continue;
      const box = node('figure', undefined, 'zli-media');
      try {
        report('正在读取视频播放入口…');
        const info = await readZhihuJSON(`/api/v4/video/play_info?r=${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-za': 'OS=webplayer' }, body: JSON.stringify({ content_id: aid, content_type_str: 'answer', video_id: id, scene_code: 'answer_detail_web', is_only_video: true }) });
        const choices = info.video_play?.playlist?.mp4 || [];
        const selected = [...choices].sort((a, b) => Number(b.bitrate) - Number(a.bitrate)).flatMap(choice => Array.isArray(choice.url) ? choice.url : [choice.url]).map(mediaURL).find(Boolean);
        if (!selected) throw new Error('播放地址不可用');
        const player = node('video'); player.controls = true; player.preload = 'none'; player.src = selected;
        box.append(player, node('p', '视频需联网播放，链接可能过期；无法播放时请打开原回答。', 'zli-note'));
      } catch { check(); box.append(node('p', '未能读取视频地址，请打开原回答播放。', 'zli-note zli-incomplete')); }
      box.append(originalLink(aid)); card.replaceWith(box);
    }
    const records = new Map(), attrs = ['data-segment-id', 'data-seg-id', 'data-segid', 'data-annotation-id'];
    for (const mark of body.querySelectorAll(attrs.map(attr => `[${attr}]`).join(','))) {
      if (records.size >= 100) break;
      const id = attrs.map(attr => mark.getAttribute(attr)).find(Boolean);
      if (/^[\w-]{1,160}$/.test(id)) records.set(id, { id, text: textOf(mark), mark });
    }
    // 仅查看当前回答的初始状态，避免把其他回答的段评错误关联。
    try {
      const initial = JSON.parse(document.getElementById('js-initialData')?.textContent || '{}');
      const state = initial.initialState?.entities?.answers?.[aid];
      segmentRecords(state?.reaction, records);
      segmentRecords(state?.annotations, records, 0, true);
      segmentRecords(state?.segments, records, 0, true);
    } catch { /* 没有可用的初始状态 */ }
    const marked = body.querySelector('.zli-original-underline, [class*="Highlight"], [class*="highlight"], [class*="Segment"], [class*="segment"], [class*="Annotation"], [data-annotation-id]');
    if (!records.size && marked && /^\d+$/.test(aid)) {
      try { segmentRecords((await readZhihuJSON(`/api/v4/answers/${aid}?include=reaction`)).reaction, records); }
      catch { check(); }
    }
    if (!records.size) {
      if (marked) { const note = node('p', '检测到划线，但未取得段落标识，段落评论和回复未完整保存。可先在知乎打开划线评论再重试。', 'zli-note zli-incomplete'); note.append(originalLink(aid)); item.append(note); }
      return;
    }
    const section = node('section', undefined, 'zli-annotations');
    section.append(node('h3', '划线段落评论与回复（导出时快照）'));
    if (records.size >= 100) section.append(node('p', '达到100个划线段评的读取上限，可能还有段评未保存。', 'zli-note zli-incomplete'));
    const budget = { remaining: 200 };
    let index = 0;
    for (const record of records.values()) {
      check(); index++;
      report(`正在读取划线段落评论和回复 ${index}/${records.size}…`);
      const detail = node('details'); detail.id = `zli-segment-${aid}-${index}`;
      const summary = node('summary', `划线 ${index}：${record.text.slice(0, 160) || '段落评论'}`); detail.append(summary);
      record.mark = markSegment(body, record);
      if (record.mark) {
        record.mark.classList.add('zli-underlined');
        const anchor = node('a', ` [查看段评 ${index}]`); anchor.href = `#${detail.id}`; record.mark.after(anchor);
      }
      if (record.text) detail.append(node('blockquote', record.text));
      const roots = await commentPages(`/api/v4/comment_v5/answers/${aid}/segment/root_comment?segment_id=${encodeURIComponent(record.id)}&limit=20&offset=`, budget);
      let count = roots.rows.length, incomplete = Boolean(roots.incomplete);
      for (const comment of roots.rows) {
        check(); const entry = commentElement(comment);
        const embedded = Array.isArray(comment.child_comments) ? comment.child_comments : [];
        const replies = new Map(embedded.map(reply => [String(reply.id), reply]));
        let replyError = '';
        if (/^[\w-]+$/.test(String(comment.id)) && (Number(comment.child_comment_count) > 0 || embedded.length > 0)) {
          const result = await commentPages(`/api/v4/comment_v5/comment/${comment.id}/child_comment?limit=20&offset=`, budget);
          for (const reply of result.rows) replies.set(String(reply.id), reply);
          replyError = result.incomplete;
          if (Number(comment.child_comment_count) > replies.size) replyError ||= '回复数量不足';
        }
        if (replies.size) {
          const children = node('details', undefined, 'zli-replies'); children.append(node('summary', `展开 ${replies.size} 条回复`));
          for (const reply of replies.values()) children.append(commentElement(reply));
          entry.append(children); count += replies.size;
        }
        if (replyError) { incomplete = true; entry.append(node('p', `回复未完整保存：${replyError}。`, 'zli-note zli-incomplete')); }
        detail.append(entry);
      }
      summary.append(document.createTextNode(` · 已保存 ${count} 条评论/回复${incomplete ? '（未完整）' : ''}`));
      if (roots.incomplete) detail.append(node('p', `段评未完整保存：${roots.incomplete}。`, 'zli-note zli-incomplete'));
      else if (!roots.rows.length) detail.append(node('p', '接口未返回可见评论。'));
      detail.append(originalLink(aid, '回知乎查看最新讨论')); section.append(detail);
    }
    item.append(section);
  }


  function snapshot(answer, index) {
    const content = answer.querySelector('.RichContent-inner .RichText')
      || answer.querySelector('.RichContent-inner')
      || answer.querySelector('.RichText');
    if (!content) return null;
    const item = node('article', undefined, 'zli-answer');
    item.append(node('h2', `回答 ${index}`));
    const author = textOf(answer.querySelector('.AuthorInfo-name')) || '匿名用户';
    item.append(node('div', author, 'zli-author'));
    const id = answerID(answer);
    if (id) item.append(node('div', `https://www.zhihu.com/question/${activeQuestion}/answer/${id}`, 'zli-meta'));
    const body = cloneContent(content);
    // 仅重排当前账号能看到的内容，不请求付费全文。
    const restricted = /盐选|付费|购买后|会员专享|开通会员/.test(textOf(answer))
      || [...answer.querySelectorAll('button')].some(el => /^(阅读全文|展开阅读全文)/.test(textOf(el)));
    if (restricted) item.append(node('p', '提示：本条可能含付费内容或未展开内容，仅导出当前账号可见部分。', 'zli-note'));
    item.append(body);
    const time = textOf(answer.querySelector('.ContentItem-time'));
    if (time) item.append(node('div', time, 'zli-meta'));
    return item;
  }

  async function questionHeader(single) {
    const detail = document.querySelector('.QuestionHeader-detail') || document.querySelector('.QuestionRichText');
    if (detail) await expand(detail.closest('.QuestionRichText') || detail);
    check();
    const header = node('header');
    const title = textOf(document.querySelector('.QuestionHeader-title')) || document.title.replace(/ - 知乎$/, '');
    header.append(node('h1', title), node('p', `https://www.zhihu.com/question/${activeQuestion}`, 'zli-meta'));
    const description = document.querySelector('.QuestionHeader-detail .RichText')
      || document.querySelector('.QuestionRichText .RichText')
      || document.querySelector('.QuestionHeader-detail');
    if (description && textOf(description)) {
      const body = cloneContent(description);
      body.classList.add('zli-question-description');
      header.append(body);
    }
    header.append(node('p', `${single ? '单条回答导出' : '页面当前排序'} · ${new Date().toLocaleString()}`, 'zli-meta'));
    return header;
  }

  function attachSingleButtons() {
    if (!questionID() || (CONFIG.QUESTION_ID && questionID() !== String(CONFIG.QUESTION_ID))) return;
    for (const answer of answerList()) {
      if (detailAnswerID() && answerID(answer) !== detailAnswerID()) continue;
      const host = answer.querySelector('.ContentItem-meta .AuthorInfo') || answer.querySelector('.AuthorInfo')
        || answer.querySelector('.ContentItem-meta') || answer.querySelector('.AuthorInfo-name')?.parentElement || answer;
      const follow = answer.querySelector('.FollowButton:not(.zli-single-export), .UserFollowButton:not(.zli-single-export)')
        || [...host.querySelectorAll('button')].find(el => !el.classList.contains('zli-single-export') && /^(?:[+＋])?(?:关注|已关注|取消关注|互相关注)$/.test(textOf(el).replace(/\s/g, '')));
      const existing = answer.querySelector('.zli-single-export');
      if (existing) { if (follow) matchFollowStyle(existing, follow); continue; }
      const button = node('button', '导出此回答', 'zli-single-export');
      button.type = 'button';
      button.title = '导出问题标题、问题描述及这条回答';
      button.disabled = busy;
      button.setAttribute('data-html2canvas-ignore', 'true');
      // 事件委托读取最近的 AnswerItem，适应知乎复用回答节点的情况。
      button.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        const selected = button.closest('.AnswerItem');
        if (selected) void run('single', selected);
      };
      if (follow && follow.parentElement) {
        follow.parentElement.insertBefore(button, follow.nextSibling);
        matchFollowStyle(button, follow);
      }
      else host.append(button);
    }
  }

  function matchFollowStyle(button, follow) {
    const key = `${follow.className}|${follow.getAttribute('style') || ''}|${document.documentElement.getAttribute('data-theme') || ''}`;
    if (button.dataset.zliStyleKey === key) return;
    button.dataset.zliStyleKey = key;
    // 只取展示属性，保持导出按钮自己的行为，不复制关注按钮的事件和标识。
    const style = getComputedStyle(follow);
    for (const property of ['height', 'min-height', 'box-sizing', 'font-family', 'font-size', 'font-weight', 'line-height',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width',
      'border-bottom-width', 'border-left-width', 'border-style', 'border-color', 'border-radius', 'background-color', 'color']) {
      button.style.setProperty(property, style.getPropertyValue(property));
    }
    button.style.setProperty('margin', '0 0 0 10px');
  }

  async function collect(count) {
    const items = [];
    const ids = new Set();
    const elements = new WeakSet();
    let idle = 0;
    let priorFingerprint = '';
    window.scrollTo(0, 0);
    await pause(CONFIG.WAIT_MS);
    for (let step = 0; step < CONFIG.MAX_SCROLL_STEPS && items.length < count; step++) {
      check();
      const answers = answerList();
      for (const answer of answers) {
        check();
        const id = answerID(answer);
        if ((id && ids.has(id)) || (!id && elements.has(answer))) continue;
        answer.scrollIntoView({ block: 'center', behavior: 'instant' });
        await expand(answer);
        const copy = snapshot(answer, items.length + 1);
        // 不跳过无正文的回答，防止把后面的条目冒充成前 X 条。
        if (!copy) throw new Error('有回答未能读取正文。请确认已登录、展开正文并刷新页面后重试。');
        await enrichHTMLInteractions(answer, copy);
        if (id) ids.add(id);
        elements.add(answer);
        items.push(copy);
        updateProgress(items.length, count);
        report(`已收集 ${items.length}/${count} 条回答…`);
        if (items.length >= count) break;
      }
      if (items.length >= count) break;
      const list = document.querySelector('.QuestionAnswers-answers') || document.querySelector('.Question-main');
      const more = [...(list?.querySelectorAll('button') || [])].find(el =>
        visible(el) && /^(加载更多|查看更多回答|显示更多回答)$/.test(textOf(el)));
      if (more) more.click();
      const last = answers.at(-1);
      if (last) {
        last.scrollIntoView({ block: 'end', behavior: 'instant' });
        window.scrollBy(0, Math.max(600, window.innerHeight));
      } else {
        window.scrollBy(0, Math.max(600, window.innerHeight));
      }
      await pause(CONFIG.WAIT_MS);
      const fingerprint = `${items.length}:${answerList().map(answerID).join(',')}:${list?.scrollHeight}`;
      idle = fingerprint === priorFingerprint ? idle + 1 : 0;
      priorFingerprint = fingerprint;
      report(`已收集 ${items.length}/${count} 条，等待后续回答${idle ? `（${idle}/10）` : ''}…`);
      if (idle >= 10) break;
    }
    return items;
  }

  function fetchImage(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: CONFIG.IMAGE_TIMEOUT_MS,
        anonymous: true,
        onload: result => {
          if (result.status < 200 || result.status >= 300 || !result.response?.type?.startsWith('image/')) {
            reject(new Error('图片响应无效')); return;
          }
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('图片读取失败'));
          reader.readAsDataURL(result.response);
        },
        onerror: () => reject(new Error('图片请求失败')),
        ontimeout: () => reject(new Error('图片请求超时')),
      });
    });
  }

  async function inlineImages(root) {
    const images = [...root.querySelectorAll('img')];
    setProgressStage('images', images.length);
    const cache = new Map();
    let failed = 0;
    let done = 0;
    async function process(img) {
      check();
      try {
        const url = new URL(img.src, location.href);
        if (url.protocol !== 'data:') {
          if (url.protocol !== 'https:' || !/(^|\.)zhimg\.com$/i.test(url.hostname)) throw new Error('非知乎图片域名');
          if (!cache.has(url.href)) cache.set(url.href, fetchImage(url.href));
          img.src = await cache.get(url.href);
        }
        // decode 在插入 DOM 前也能预加载图片。
        if (img.decode) await img.decode();
        if (!img.naturalWidth) throw new Error('图片无法解码');
      } catch {
        failed++;
        img.replaceWith(node('p', `【图片未能载入${img.alt ? `：${img.alt}` : ''}，请查看原回答】`, 'zli-note'));
      }
      done++;
      updateProgress(done, images.length);
      report(`处理图片 ${done}/${images.length}…${failed ? `（${failed}张未能载入）` : ''}`);
    }
    // 固定批次并行，既限制并发，也确保取消后没有遗留的后台工作。
    for (let i = 0; i < images.length; i += 4) {
      const results = await Promise.allSettled(images.slice(i, i + 4).map(process));
      check();
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
    return failed;
  }

  function dimensions(width, height) {
    const scale = CONFIG.SCALE;
    if (!Number.isInteger(scale) || scale < 1 || scale > 4 || width * scale > 30000) {
      throw new Error('SCALE 必须为1～4的整数，且输出宽度不得超过30000像素。');
    }
    if (height * scale > CONFIG.MAX_HEIGHT || width * height * scale * scale > CONFIG.MAX_PIXELS) {
      throw new Error('内容超过单张高清图的画布限制。请点击“高清分图”保留清晰度，或减小 X；新版不会自动缩糊。');
    }
    return { scale, width: width * scale, height: height * scale };
  }

  function planParts(width, height, mode) {
    if (!['single', 'split'].includes(mode)) throw new Error('EXPORT_MODE 只能是 single 或 split。');
    dimensions(width, 1); // 校验倍率及宽度配置。
    if (mode === 'single') return [{ y: 0, height, ...dimensions(width, height), cssHeight: height }];
    const capacity = Math.floor(Math.min(CONFIG.MAX_HEIGHT / CONFIG.SCALE,
      CONFIG.MAX_PIXELS / (width * CONFIG.SCALE * CONFIG.SCALE)));
    if (capacity < 1) throw new Error('画布预算过小，请检查 MAX_HEIGHT 和 MAX_PIXELS。');
    const parts = [];
    for (let y = 0; y < height; y += capacity) {
      const h = Math.min(capacity, height - y);
      parts.push({ y, cssHeight: h, ...dimensions(width, h) });
    }
    return parts;
  }

  // 按 PNG 标准封装块。所有 IDAT 共用同一个连续 zlib 流。
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });

  function pngChunk(type, data) {
    const chunk = new Uint8Array(data.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < chunk.length - 4; i++) crc = crcTable[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
    view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
    return chunk;
  }

  function createStreamingPNG(width, height) {
    if (typeof CompressionStream === 'undefined') throw new Error('当前浏览器不支持流式压缩，请更新桌面 Chrome / Edge / Firefox，或使用高清分图。');
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 0x7fffffff)) throw new Error('PNG 尺寸无效。');
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8; // 8 bit
    ihdr[9] = 6; // RGBA
    const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr)];
    const stream = new CompressionStream('deflate');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    let bytes = 33;
    let rows = 0;
    let failure;
    const previousRow = new Uint8Array(width * 4);
    // 同时消费压缩输出，否则流的背压会让 write() 一直等待。
    const drain = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length + 12;
          if (bytes > CONFIG.MAX_FILE_MB * 1024 * 1024) throw new Error('PNG 文件超过内存保护上限，请减小 X 或适当提高 MAX_FILE_MB。');
          chunks.push(pngChunk('IDAT', value));
        }
      } catch (error) {
        failure = error;
        await reader.cancel(error).catch(() => {});
      }
    })();
    return {
      async writeRows(rgba, count) {
        if (failure) throw failure;
        const stride = width * 4;
        if (!Number.isInteger(count) || count < 1 || rows + count > height || rgba.length !== stride * count) throw new Error('PNG 行数据尺寸不匹配。');
        const filtered = new Uint8Array((stride + 1) * count);
        // Up 过滤器跨截图块保留上一行，压缩不改变任何像素。
        for (let row = 0; row < count; row++) {
          const src = row * stride;
          const dst = row * (stride + 1);
          filtered[dst] = 2;
          if (row === 0) {
            for (let b = 0; b < stride; b++) filtered[dst + 1 + b] = (rgba[src + b] - previousRow[b]) & 255;
          } else {
            for (let b = 0; b < stride; b++) filtered[dst + 1 + b] = (rgba[src + b] - rgba[src - stride + b]) & 255;
          }
        }
        // 每批只复制最后一行，不再对每一行做额外的整行复制。
        previousRow.set(rgba.subarray((count - 1) * stride, count * stride));
        await writer.write(filtered);
        rows += count;
        if (failure) throw failure;
      },
      async finish() {
        if (rows !== height) throw new Error('PNG 行数不完整，已停止导出。');
        await writer.close();
        await drain;
        if (failure) throw failure;
        chunks.push(pngChunk('IEND', new Uint8Array()));
        return new Blob(chunks, { type: 'image/png' });
      },
      async abort() {
        await Promise.allSettled([writer.abort(), reader.cancel()]);
        await drain;
        chunks.length = 0;
      },
    };
  }

  async function renderStreaming(root) {
    const width = CONFIG.WIDTH;
    const height = Math.ceil(root.getBoundingClientRect().height);
    const scale = dimensions(width, 1).scale;
    const outputWidth = width * scale;
    const outputHeight = height * scale;
    const captureOptions = {
      backgroundColor: '#ffffff', scale, useCORS: true, allowTaint: false,
      logging: false, imageTimeout: CONFIG.IMAGE_TIMEOUT_MS,
      width, scrollX: 0, scrollY: 0, windowWidth: Math.max(1200, width), windowHeight: 900,
      ignoreElements: el => el.id === 'zli-panel' || el.id === 'zli-preview',
    };
    // 中等尺寸优先原生编码，省去多次克隆DOM及JavaScript逐像素过滤。
    if (typeof HTMLCanvasElement !== 'undefined' && outputHeight <= CONFIG.MAX_HEIGHT
      && outputWidth * outputHeight <= Math.min(CONFIG.MAX_PIXELS, CONFIG.PNG_FAST_MAX_PIXELS)) {
      check(); report(`正在生成高清PNG（原生快速编码，${outputWidth} × ${outputHeight}）…`);
      const canvas = await html2canvas(root, { ...captureOptions, x: 0, y: 0, height });
      try {
        check();
        if (canvas.width !== outputWidth || canvas.height !== outputHeight) throw new Error('截图尺寸异常。');
        report('截图完成，正在进行PNG无损压缩…');
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        check();
        if (!blob) throw new Error('PNG编码失败，请降低清晰度或使用分图。');
        if (blob.size > CONFIG.MAX_FILE_MB * 1024 * 1024) throw new Error('PNG文件超过内存保护上限。');
        return [{ blob, width: outputWidth, height: outputHeight, scale }];
      } finally { canvas.width = canvas.height = 0; }
    }
    const encoder = createStreamingPNG(outputWidth, outputHeight);
    let tile;
    let previewBlob;
    // 画布始终只有一小块；最终文件高度不再受整张 canvas 的高度限制。
    // 减少html2canvas反复克隆/解析整页的次数，同时限制单块像素和内存。
    const tileHeight = Math.min(6000, Math.floor(Math.min(CONFIG.MAX_PIXELS, 24000000) / (width * scale * scale)), Math.floor(CONFIG.MAX_HEIGHT / scale));
    const rowsPerBatch = Math.max(1, Math.min(1024, Math.floor(4 * 1024 * 1024 / (outputWidth * 4))));
    const needsPreview = outputHeight > 30000 || outputWidth * outputHeight > CONFIG.MAX_PIXELS;
    let lastYield = Date.now();
    if (tileHeight < 1) { await encoder.abort(); throw new Error('截图块像素预算过小。'); }
    try {
      for (let y = 0; y < height; y += tileHeight) {
        check();
        const h = Math.min(tileHeight, height - y);
        report(`正在编码一张高清长图 ${Math.round(y / height * 100)}%（${outputWidth} × ${outputHeight}，${scale}倍）…`);
        tile = await html2canvas(root, { ...captureOptions, x: 0, y, height: h });
        if (tile.width !== outputWidth || tile.height !== h * scale) throw new Error('截图块尺寸异常。');
        const ctx = tile.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('无法读取截图像素。');
        if (y === 0 && needsPreview) {
          const preview = document.createElement('canvas');
          preview.width = tile.width; preview.height = Math.min(tile.height, 1600);
          const previewContext = preview.getContext('2d');
          if (previewContext) {
            previewContext.drawImage(tile, 0, 0);
            previewBlob = await new Promise(resolve => preview.toBlob(resolve, 'image/png'));
          }
          preview.width = preview.height = 0;
        }
        for (let row = 0; row < tile.height; row += rowsPerBatch) {
          check();
          const count = Math.min(rowsPerBatch, tile.height - row);
          const pixels = ctx.getImageData(0, row, tile.width, count).data;
          await encoder.writeRows(pixels, count);
          // 保持取消和界面响应，但不再每128行插入一次定时器等待。
          if (Date.now() - lastYield >= 24) { await pause(0); lastYield = Date.now(); }
        }
        tile.width = tile.height = 0;
        tile = null;
        updateProgress(y + h, height);
      }
      check();
      report('截图内容已处理，正在完成PNG压缩…');
      const blob = await encoder.finish();
      return [{ blob, previewBlob, width: outputWidth, height: outputHeight, scale }];
    } catch (error) {
      await encoder.abort();
      throw error;
    } finally {
      if (tile) tile.width = tile.height = 0;
    }
  }

  async function renderPart(root, part, partIndex, partCount) {
    const width = CONFIG.WIDTH;
    const height = part.cssHeight;
    const size = part;
    const fullHeight = Math.ceil(root.getBoundingClientRect().height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器无法创建画布，请减小 X。');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // 分块绘制后拼到一个画布，避免先创建超高的中间截图。
    const tileHeight = 2000;
    for (let y = 0; y < height; y += tileHeight) {
      check();
      const h = Math.min(tileHeight, height - y);
      report(`高清图 ${partIndex + 1}/${partCount}：${Math.round(y / height * 100)}%（${size.width} × ${size.height}，${size.scale}倍）…`);
      const tile = await html2canvas(root, {
        backgroundColor: '#ffffff', scale: size.scale, useCORS: true,
        allowTaint: false, logging: false, imageTimeout: CONFIG.IMAGE_TIMEOUT_MS,
        x: 0, y: part.y + y, width, height: h, scrollX: 0, scrollY: 0,
        windowWidth: Math.max(1200, width), windowHeight: 900,
        ignoreElements: el => el.id === 'zli-panel' || el.id === 'zli-preview',
      });
      // 整数倍率、原像素复制：避免拼接时再次缩放和插值。
      const top = y * size.scale;
      if (tile.width !== size.width || tile.height !== h * size.scale) {
        throw new Error('截图块尺寸异常，已停止导出，避免生成模糊或缺失的图片。');
      }
      ctx.drawImage(tile, 0, top);
      tile.width = tile.height = 0;
      updateProgress(part.y + y + h, fullHeight);
      await pause(0);
    }
    check();
    const mime = CONFIG.FORMAT === 'webp' ? 'image/webp' : 'image/png';
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, CONFIG.WEBP_QUALITY));
    canvas.width = canvas.height = 0;
    if (!blob || blob.type !== mime) throw new Error(`${mime} 编码失败，请减小 X 或降低 SCALE。`);
    return { blob, ...size };
  }

  function webPLimits(width, height, scale = CONFIG.SCALE) {
    const capacity = Math.floor(Math.min(16380 / scale, CONFIG.MAX_HEIGHT / scale,
      CONFIG.MAX_PIXELS / (width * scale * scale)));
    const shrinkScale = Math.min(scale, 16380 / width, 16380 / height,
      Math.sqrt(CONFIG.MAX_PIXELS / (width * height)));
    return { capacity, shrinkScale, shrinkWidth: Math.floor(width * shrinkScale), shrinkHeight: Math.floor(height * shrinkScale) };
  }

  function chooseWebPOverflow(height, limits) {
    setProgressStage('waiting');
    report('内容超过单张WebP限制，请选择导出方式；已收集的回答会继续使用。');
    return new Promise(resolve => {
      const overlay = node('div'); overlay.id = 'zli-webp-choice';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0009;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box';
      const dialog = node('div'); dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'zli-webp-title'); dialog.setAttribute('aria-describedby', 'zli-webp-description');
      dialog.style.cssText = 'width:480px;max-width:100%;padding:24px;border-radius:12px;background:#fff;color:#222;font:14px/1.7 sans-serif;box-shadow:0 8px 40px #0004';
      const title = node('h3', '内容太长，请选择WebP导出方式'); title.id = 'zli-webp-title'; title.style.cssText = 'font-size:19px;margin:0 0 12px';
      const description = node('p', `当前预计 ${CONFIG.WIDTH * CONFIG.SCALE} × ${height * CONFIG.SCALE} 像素，超过单张WebP可编码的尺寸。可以分图保持清晰，也可以本次改为PNG。`);
      description.id = 'zli-webp-description';
      dialog.append(title, description);
      let timer;
      let finished = false;
      const finish = choice => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        overlay.remove();
        if (choice !== 'cancel') setProgressStage('render');
        resolve(choice);
      };
      const choices = [
        ['split', '保持清晰度，导出多张WebP（推荐）', CONFIG.WIDTH * CONFIG.SCALE <= 16383 && limits.capacity > 0],
        ['shrink', `缩小为单张WebP（${limits.shrinkWidth} × ${limits.shrinkHeight}，文字会变小）`, limits.shrinkWidth >= 320],
        ['png', '本次改用一张高清PNG', true],
        ['cancel', '取消，返回页面', true],
      ];
      const buttons = [];
      for (const [choice, label, enabled] of choices) {
        const button = node('button', label); button.type = 'button'; button.disabled = !enabled;
        button.style.cssText = `display:block;width:100%;padding:10px 12px;margin:10px 0 0;border:1px solid #c8d7ec;border-radius:7px;text-align:left;font:14px/1.6 sans-serif;cursor:pointer;background:${choice === 'split' ? '#056de8' : '#f4f7fb'};color:${choice === 'split' ? '#fff' : '#234'};opacity:${enabled ? 1 : .45}`;
        button.onclick = () => finish(choice); dialog.append(button); buttons.push(button);
      }
      if (limits.shrinkWidth < 320) dialog.append(node('p', '缩成单张后宽度过小、文字难以辨认，因此禁用了缩小选项。'));
      dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') finish('cancel');
        if (event.key === 'Tab') {
          const enabled = buttons.filter(button => !button.disabled);
          const index = enabled.indexOf(document.activeElement);
          event.preventDefault(); enabled[(index + (event.shiftKey ? -1 : 1) + enabled.length) % enabled.length].focus();
        }
      });
      overlay.append(dialog); document.body.append(overlay); buttons.find(button => !button.disabled).focus();
      timer = setInterval(() => { if (cancelled || questionID() !== activeQuestion) finish('cancel'); }, 200);
    });
  }

  async function renderShrunkWebP(root, height, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(CONFIG.WIDTH * scale); canvas.height = Math.floor(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器无法创建WebP画布。');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const tileHeight = Math.max(1, Math.min(2000, Math.floor(CONFIG.MAX_PIXELS / (CONFIG.WIDTH * CONFIG.SCALE ** 2))));
    let tile;
    try {
      for (let y = 0; y < height; y += tileHeight) {
        check();
        report(`按所选尺寸生成单张WebP ${Math.round(y / height * 100)}%（${canvas.width} × ${canvas.height}）…`);
        const h = Math.min(tileHeight, height - y);
        tile = await html2canvas(root, {
          backgroundColor: '#fff', scale: CONFIG.SCALE, useCORS: true, allowTaint: false, logging: false,
          imageTimeout: CONFIG.IMAGE_TIMEOUT_MS, x: 0, y, width: CONFIG.WIDTH, height: h,
          scrollX: 0, scrollY: 0, windowWidth: Math.max(1200, CONFIG.WIDTH), windowHeight: 900,
          ignoreElements: el => el.id === 'zli-panel' || el.id === 'zli-preview',
        });
        const top = Math.floor(y * scale), bottom = Math.floor((y + h) * scale);
        if (bottom > top) ctx.drawImage(tile, 0, top, canvas.width, bottom - top);
        tile.width = tile.height = 0; tile = null;
        updateProgress(y + h, height);
        await pause(0);
      }
      check();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', CONFIG.WEBP_QUALITY));
      if (!blob || blob.type !== 'image/webp') throw new Error('WebP编码失败，请选择PNG或高清分图。');
      return [{ blob, width: canvas.width, height: canvas.height, scale, notice: '按你的选择缩小为单张WebP，文字和图片尺寸已减小' }];
    } finally { canvas.width = canvas.height = 0; if (tile) tile.width = tile.height = 0; }
  }

  async function render(root, mode = CONFIG.EXPORT_MODE) {
    if (CONFIG.FORMAT === 'webp') {
      const height = Math.ceil(root.getBoundingClientRect().height);
      const size = dimensions(CONFIG.WIDTH, 1);
      const limits = webPLimits(CONFIG.WIDTH, height);
      const { capacity } = limits;
      if (size.width > 16383 || (mode === 'single' && height > capacity)) {
        const choice = await chooseWebPOverflow(height, limits);
        if (choice === 'cancel') return null;
        check();
        if (choice === 'png') {
          // 本次使用PNG；不覆盖用户记住的WebP偏好。
          CONFIG.FORMAT = 'png';
          return renderStreaming(root);
        }
        if (choice === 'shrink') return renderShrunkWebP(root, height, limits.shrinkScale);
      }
      const results = [];
      for (let y = 0; y < height; y += capacity) {
        const h = Math.min(capacity, height - y);
        results.push(await renderPart(root, { y, cssHeight: h, ...dimensions(CONFIG.WIDTH, h) }, results.length, Math.ceil(height / capacity)));
      }
      return results;
    }
    if (mode === 'single') return renderStreaming(root);
    const height = Math.ceil(root.getBoundingClientRect().height);
    const parts = planParts(CONFIG.WIDTH, height, mode);
    const results = [];
    for (let i = 0; i < parts.length; i++) {
      check();
      results.push(await renderPart(root, parts[i], i, parts.length));
    }
    return results;
  }

  function allowedMediaURL(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
        && /(^|\.)(zhihu\.com|zhimg\.com|vzuu\.com)$/.test(url.hostname);
    } catch { return false; }
  }
  async function fetchMediaBlob(url) {
    check();
    if (url.startsWith('data:')) return (await fetch(url)).blob();
    if (!allowedMediaURL(url)) throw new Error('该媒体不属于支持的知乎媒体域名');
    return new Promise((resolve, reject) => {
      let done = false, request, timer;
      const finish = (error, blob) => { if (done) return; done = true; clearInterval(timer); error ? reject(error) : resolve(blob); };
      timer = setInterval(() => { if (cancelled || questionID() !== activeQuestion) { request?.abort?.(); finish(new Error('已取消')); } }, 150);
      request = GM_xmlhttpRequest({ method: 'GET', url, responseType: 'blob', timeout: 60000, anonymous: true,
        zliMedia: true,
        onprogress: event => {
          report(`正在下载音视频：${formatBytes(event.loaded || 0)}${event.total ? ` / ${formatBytes(event.total)}` : ''}…`);
          if (event.loaded > 32 * 1024 * 1024) { request?.abort?.(); finish(new Error('单个音视频超过32MB')); }
        },
        onload: response => {
          const blob = response.response;
          if (response.status < 200 || response.status >= 300 || !blob || typeof blob.arrayBuffer !== 'function' || !blob.size) return finish(new Error('音视频响应无效'));
          if (blob.size > 32 * 1024 * 1024) return finish(new Error('单个音视频超过32MB'));
          if (!/^(audio|video)\//.test(blob.type)) return finish(new Error('媒体类型不支持，可能是分段或加密播放流'));
          finish(null, blob);
        }, onerror: error => finish(new Error(error?.message || '音视频下载失败')), ontimeout: () => finish(new Error('音视频下载超时')), onabort: () => finish(new Error('音视频下载已取消')),
      });
    });
  }
  async function bundleHTMLMedia(root) {
    const players = [...root.querySelectorAll('.zli-media video, .zli-media audio')], files = [], cache = new Map();
    let total = 0, done = 0;
    for (const player of players) {
      check(); report(`正在下载离线音视频 ${++done}/${players.length}…`);
      const urls = [player.getAttribute('src'), ...[...player.querySelectorAll('source')].map(source => source.getAttribute('src'))].filter(Boolean);
      let saved, lastError;
      for (const url of urls) {
        try {
          if (cache.has(url)) { saved = cache.get(url); break; }
          if (total >= 128 * 1024 * 1024) throw new Error('音视频总大小达到128MB上限');
          const blob = await fetchMediaBlob(url); check();
          if (blob.size > 32 * 1024 * 1024 || total + blob.size > 128 * 1024 * 1024) throw new Error('超过音视频大小上限（单个32MB、合计128MB）');
          const mime = blob.type.split(';')[0].toLowerCase();
          const ext = ({'video/mp4':'mp4','video/webm':'webm','video/ogg':'ogv','audio/mpeg':'mp3','audio/mp3':'mp3','audio/mp4':'m4a','audio/x-m4a':'m4a','audio/wav':'wav','audio/x-wav':'wav','audio/ogg':'ogg','audio/webm':'webm','audio/aac':'aac','audio/flac':'flac'})[mime];
          if (!ext) throw new Error(`不支持的离线媒体类型：${mime}`);
          saved = { name: `media/media-${String(files.length + 1).padStart(3, '0')}.${ext}`, blob };
          files.push(saved); cache.set(url, saved); total += blob.size; break;
        } catch (error) { check(); lastError = error; }
      }
      const box = player.closest('.zli-media');
      box.querySelectorAll('.zli-note,figcaption').forEach(note => note.remove());
      if (saved) {
        player.removeAttribute('src'); player.querySelectorAll('source').forEach(source => source.remove());
        player.setAttribute('src', saved.name);
        box.append(node('figcaption', `已下载，可离线播放 · ${formatBytes(saved.blob.size)}`));
      } else player.replaceWith(node('p', `音视频未能下载：${lastError?.message || '地址不可用'}。请打开原回答播放。`, 'zli-note zli-incomplete'));
    }
    return { files, hasMedia: players.length > 0 };
  }
  // 媒体已压缩，ZIP采用Store避免重复压缩；分块计算CRC以保持取消/界面响应。
  async function mediaZIP(files) {
    if (files.length > 65535 || files.reduce((sum, file) => sum + file.blob.size, 0) > 512 * 1024 * 1024) throw new Error('离线ZIP超过512MB或文件数上限，请减少导出回答数。');
    const chunks = [], central = [], encoder = new TextEncoder(); let offset = 0, centralSize = 0;
    for (const file of files) {
      check();
      const name = encoder.encode(file.name); let crc = 0xffffffff;
      for (let at = 0; at < file.blob.size; at += 1024 * 1024) {
        const bytes = new Uint8Array(await file.blob.slice(at, at + 1024 * 1024).arrayBuffer());
        for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
        check(); await pause(0);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const local = new Uint8Array(30), view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true); view.setUint16(12, 0x21, true);
      view.setUint32(14, crc, true); view.setUint32(18, file.blob.size, true); view.setUint32(22, file.blob.size, true); view.setUint16(26, name.length, true);
      chunks.push(local, name, file.blob);
      const entry = new Uint8Array(46), index = new DataView(entry.buffer);
      index.setUint32(0, 0x02014b50, true); index.setUint16(4, 20, true); index.setUint16(6, 20, true); index.setUint16(8, 0x800, true); index.setUint16(14, 0x21, true);
      index.setUint32(16, crc, true); index.setUint32(20, file.blob.size, true); index.setUint32(24, file.blob.size, true); index.setUint16(28, name.length, true); index.setUint32(42, offset, true);
      central.push(entry, name); centralSize += entry.length + name.length; offset += local.length + name.length + file.blob.size;
    }
    const end = new Uint8Array(22), view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true); view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end], { type: 'application/zip' });
  }

  function portableDocument(root, mediaFiles = []) {
    const mediaPaths = new Set(mediaFiles.map(file => file.name));
    const copy = root.cloneNode(true);
    copy.querySelectorAll('script, iframe, object, embed, form, button, input, select, textarea, link, base, meta').forEach(el => el.remove());
    for (const el of [copy, ...copy.querySelectorAll('*')]) {
      const visual = ['opacity', 'filter', 'mix-blend-mode'].map(property => [property, el.style.getPropertyValue(property)]);
      // 离线文件只保留静态内容，不携带站点埋点、事件或外部资源。
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || attr.name.startsWith('data-') || ['srcset', 'style', 'contenteditable', 'poster', 'background'].includes(attr.name)) el.removeAttribute(attr.name);
      }
      for (const [property, value] of visual) {
        if (value && !/url\s*\(|[<>]/i.test(value)) el.style.setProperty(property, value, 'important');
      }
      const src = el.getAttribute('src') || '';
      const media = htmlInteractive() && /^(AUDIO|VIDEO|SOURCE)$/.test(el.tagName) && el.closest('.zli-media') && (mediaURL(src)?.startsWith('data:') || mediaPaths.has(src));
      if (el.hasAttribute('src') && !(el.tagName === 'IMG' && /^data:image\//i.test(src)) && !media) el.removeAttribute('src');
      for (const name of ['href', 'xlink:href']) if (el.hasAttribute(name)) {
        const href = el.getAttribute(name);
        const isLink = el.localName.toLowerCase() === 'a';
        if (!(href.startsWith('#') || (isLink && /^https?:\/\//i.test(href)) || (!isLink && /^data:image\//i.test(href)))) el.removeAttribute(name);
        else if (isLink && !href.startsWith('#')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
        else if (isLink) el.removeAttribute('target');
      }
    }
    const rules = css.textContent.match(/#zli-stage[^{}]*\{[^{}]*\}/g) || [];
    const styles = rules.join('\n').replace('position:absolute!important', 'position:relative!important')
      .replace('pointer-events:none', 'pointer-events:auto')
      + `\n#zli-stage{width:${CONFIG.WIDTH}px;max-width:100%;margin:0 auto}body{margin:0;background:#fff;color:#222}img{max-width:100%}`;
    return { copy, styles };
  }

  function planPDFPages(totalHeight, pageHeight, images = [], keepImages = true) {
    const pages = [];
    let y = 0;
    while (y < totalHeight) {
      let end = Math.min(y + pageHeight, totalHeight);
      if (keepImages) {
        for (let pass = 0; pass <= images.length; pass++) {
          const crossing = images.filter(image => image.top < end && image.bottom > end);
          if (!crossing.length) break;
          const beforeImage = Math.min(...crossing.map(image => image.top));
          if (beforeImage <= y) throw new Error('图片布局无法完整放入一页，请降低排版宽度或关闭“图片不跨页”后重试。');
          end = beforeImage;
        }
      }
      if (end <= y) throw new Error('PDF分页未能前进，已停止。');
      pages.push({ y, height: end - y });
      y = end;
    }
    return pages;
  }

  async function exportDocument(root, format) {
    if (format === 'html' || format === 'svg') {
      report(`正在生成 ${format.toUpperCase()}，保留真实文字和内嵌图片…`);
      const bundle = format === 'html' && htmlInteractive() ? await bundleHTMLMedia(root) : { files: [], hasMedia: false };
      const { copy, styles } = portableDocument(root, bundle.files);
      const width = CONFIG.WIDTH;
      let height = Math.ceil(root.getBoundingClientRect().height);
      if (format === 'html') {
        const doc = document.implementation.createHTMLDocument('知乎回答导出 · jasonLi');
        const charset = doc.createElement('meta'); charset.setAttribute('charset', 'utf-8');
        const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy';
        csp.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'self' file: data:; font-src 'none'; base-uri 'none'; form-action 'none'";
        const viewport = doc.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1';
        const style = doc.createElement('style'); style.textContent = styles;
        doc.head.prepend(charset, csp, viewport); doc.head.append(style); doc.body.append(copy);
        const html = new Blob(['<!doctype html>\n', doc.documentElement.outerHTML], { type: 'text/html;charset=utf-8' });
        if (bundle.hasMedia) {
          report('正在打包离线HTML和音视频…');
          const readme = new Blob(['请先完整解压ZIP，再用Chrome/Edge打开index.html。不要直接在压缩包内打开。\nmedia/内为已下载的音视频；请保持目录结构。段评为导出时快照。下载失败的媒体已在主页面标明。\n'], { type: 'text/plain;charset=utf-8' });
          const blob = await mediaZIP([{ name: 'index.html', blob: html }, ...bundle.files, { name: 'README.txt', blob: readme }]);
          return [{ blob, width, height, extension: 'zip', mediaCount: bundle.files.length }];
        }
        return [{ blob: html, width, height }];
      }
      // 使用导出文件自身的样式重新测量，避免移除知乎样式后SVG高度不够而截断。
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('data-html2canvas-ignore', 'true');
      frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:900px;border:0;visibility:hidden`;
      document.body.append(frame);
      try {
        const doc = frame.contentDocument;
        const style = doc.createElement('style'); style.textContent = styles;
        doc.head.append(style); doc.body.append(copy.cloneNode(true));
        const images = [...doc.images];
        await Promise.allSettled(images.map(img => img.decode()));
        if (doc.fonts?.ready) await doc.fonts.ready;
        height = Math.ceil(doc.getElementById('zli-stage').getBoundingClientRect().height);
      } finally { frame.remove(); }
      check();
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('xmlns', ns); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const title = document.createElementNS(ns, 'title'); title.textContent = '知乎问题与回答 · jasonLi'; svg.append(title);
      const foreign = document.createElementNS(ns, 'foreignObject');
      foreign.setAttribute('width', '100%'); foreign.setAttribute('height', '100%');
      const wrapper = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      const style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style'); style.textContent = styles;
      wrapper.append(style, copy); foreign.append(wrapper); svg.append(foreign);
      return [{ blob: new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }), width, height }];
    }
    if (format === 'pdf') {
      if (!globalThis.jspdf?.jsPDF) throw new Error('PDF库尚未加载，请检查安装是否完整。');
      const pdf = new globalThis.jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
      pdf.setProperties({ title: 'Zhihu answers', author: 'jasonLi', creator: 'Zhihu Long Image' });
      const contentWidthMM = 190, marginMM = 10;
      const pageHeight = Math.floor(CONFIG.WIDTH * 277 / contentWidthMM);
      if (CONFIG.PDF_KEEP_IMAGES) {
        // 仅调整待导出的副本，避免高于整页的照片无论从哪分页都被切断。
        for (const image of root.querySelectorAll('img')) {
          if (image.getBoundingClientRect().height > pageHeight - 16) {
            image.style.setProperty('max-height', `${pageHeight - 16}px`, 'important');
            image.style.setProperty('width', 'auto', 'important');
            image.style.setProperty('height', 'auto', 'important');
            image.style.setProperty('object-fit', 'contain', 'important');
          }
        }
      }
      const totalHeight = Math.ceil(root.getBoundingClientRect().height);
      const origin = root.getBoundingClientRect().top;
      const images = [...root.querySelectorAll('img')].map(image => {
        const box = image.getBoundingClientRect();
        return { top: Math.max(0, Math.floor(box.top - origin)), bottom: Math.min(totalHeight, Math.ceil(box.bottom - origin)) };
      }).filter(image => image.bottom > image.top);
      const slices = planPDFPages(totalHeight, pageHeight, images, CONFIG.PDF_KEEP_IMAGES);
      let pages = 0;
      for (const { y, height: h } of slices) {
        check();
        report(`正在生成 PDF 第 ${pages + 1}/${slices.length} 页${CONFIG.PDF_KEEP_IMAGES ? '（图片不跨页）' : ''}…`);
        const tile = await html2canvas(root, {
          backgroundColor: '#fff', scale: CONFIG.SCALE, useCORS: true, allowTaint: false,
          logging: false, imageTimeout: CONFIG.IMAGE_TIMEOUT_MS, x: 0, y, width: CONFIG.WIDTH, height: h,
          scrollX: 0, scrollY: 0, windowWidth: Math.max(1200, CONFIG.WIDTH), windowHeight: 900,
          ignoreElements: el => el.id === 'zli-panel' || el.id === 'zli-preview',
        });
        if (pages++) pdf.addPage();
        pdf.addImage(tile.toDataURL('image/jpeg', 0.96), 'JPEG', marginMM, marginMM, contentWidthMM, h / CONFIG.WIDTH * contentWidthMM);
        tile.width = tile.height = 0;
        updateProgress(pages, slices.length);
        await pause(0);
      }
      check();
      return [{ blob: pdf.output('blob'), pages }];
    }
    throw new Error('不支持的格式。');
  }

  function syncFormatUI() {
    const format = formatInput.value;
    const raster = format === 'png' || format === 'webp';
    splitStart.style.display = raster ? '' : 'none';
    start.textContent = raster ? '单张高清长图' : `导出 ${format.toUpperCase()}`;
    scaleInput.disabled = busy || format === 'html' || format === 'svg';
    htmlOptions.style.display = format === 'html' ? 'flex' : 'none';
    htmlInteractiveInput.disabled = busy;
    pdfOptions.style.display = format === 'pdf' ? 'flex' : 'none';
    pdfKeepInput.disabled = busy;
    const notes = {
      png: 'PNG：无损长图；尺寸允许时快速编码，文件可能更大。',
      svg: 'SVG：真实文字＋内嵌图片，推荐浏览器打开；部分看图软件不支持。',
      html: 'HTML：文字图片可离线阅读；包含音视频时打包ZIP，解压后打开index.html。',
      pdf: 'PDF：自动分页，使用高清截图排版，文字不可选择。',
      webp: 'WebP：95%质量压缩；超长时可选择分图、缩小或改用PNG。',
    };
    formatNote.textContent = notes[format];
  }

  function showPreview(results, filename, info) {
    document.getElementById('zli-preview')?.remove();
    previewURLs.forEach(url => URL.revokeObjectURL(url));
    previewURLs = [];
    const modal = node('div', undefined);
    modal.id = 'zli-preview';
    const box = node('div', undefined, 'zli-preview-box');
    const format = results[0]?.extension === 'zip' ? 'ZIP' : CONFIG.FORMAT.toUpperCase();
    const imageFormat = ['PNG', 'WEBP', 'SVG'].includes(format);
    box.append(node('h3', `${format} 已生成`), node('p', info));
    box.append(node('p', imageFormat ? '预览默认适应窗口，会缩小显示；点击“100%像素查看”检查真实清晰度。下载时保留原始分辨率。' : format === 'ZIP' ? '完整解压ZIP后打开 index.html；保持 media 文件夹位置，即可离线播放已下载的音视频。' : '点击下载保存离线文件。HTML可用浏览器打开；PDF可用PDF阅读器打开。'));
    const zoom = node('button', '100%像素查看');
    let actualSize = false;
    zoom.onclick = () => {
      actualSize = !actualSize;
      box.querySelectorAll('img').forEach(img => { img.style.maxWidth = actualSize ? 'none' : '100%'; });
      zoom.textContent = actualSize ? '适应窗口' : '100%像素查看';
    };
    const close = node('button', '关闭');
    close.onclick = () => {
      modal.remove();
      previewURLs.forEach(url => URL.revokeObjectURL(url));
      previewURLs = [];
    };
    if (imageFormat) box.append(zoom);
    box.append(close);
    results.forEach((result, i) => {
      const url = URL.createObjectURL(result.blob);
      previewURLs.push(url);
      const download = node('a', results.length === 1 ? `下载 ${format}${imageFormat ? ' 长图' : ' 文件'}` : `下载第 ${i + 1}/${results.length} 张`, 'zli-download');
      download.href = url;
      download.download = results.length === 1 ? filename : filename.replace(/\.[^.]+$/, `_分图${String(i + 1).padStart(3, '0')}.${CONFIG.FORMAT}`);
      if (!imageFormat) { box.append(download); return; }
      const imageBox = node('div', undefined, 'zli-image-box');
      const img = node('img');
      const large = result.height > 30000 || result.width * result.height > CONFIG.MAX_PIXELS;
      if (large && result.previewBlob) {
        const preview = URL.createObjectURL(result.previewBlob);
        previewURLs.push(preview);
        img.src = preview;
        box.append(node('p', '下方仅预览顶部，避免浏览器解码超长图失败。下载得到的是一张完整高清 PNG。部分查看器可能无法打开超大图片。'));
      } else {
        img.src = url;
      }
      img.alt = `高清长图 ${i + 1}：${result.width} × ${result.height}`;
      imageBox.append(img);
      box.append(download, node('span', formatBytes(result.blob.size), 'zli-file-size'), imageBox);
    });
    modal.append(box);
    document.body.append(modal);
  }

  async function run(mode = CONFIG.EXPORT_MODE, selectedAnswer = null) {
    if (busy) return;
    if (!selectedAnswer && detailAnswerID()) {
      report('当前为单条回答页，请点击该回答作者栏的“导出此回答”。批量导出请返回问题列表。'); return;
    }
    CONFIG.ANSWER_COUNT = Number(countInput.value);
    CONFIG.SCALE = Number(scaleInput.value);
    CONFIG.FORMAT = formatInput.value;
    const count = selectedAnswer ? 1 : Number(CONFIG.ANSWER_COUNT);
    if (!Number.isInteger(count) || count < 1 || !Number.isFinite(CONFIG.WIDTH) || CONFIG.WIDTH < 400) {
      report('配置有误：ANSWER_COUNT 必须是正整数，WIDTH 至少为400。'); return;
    }
    busy = true;
    cancelled = false;
    clearInterval(progressTimer);
    Object.assign(taskProgress, { started: Date.now(), ended: 0 });
    setProgressStage('collect', count);
    progressTimer = setInterval(paintProgress, 1000);
    activeQuestion = questionID();
    start.disabled = true;
    splitStart.disabled = true;
    countInput.disabled = scaleInput.disabled = formatInput.disabled = pdfKeepInput.disabled = htmlInteractiveInput.disabled = true;
    CONFIG.PDF_KEEP_IMAGES = pdfKeepInput.checked;
    CONFIG.HTML_INTERACTIVE = htmlInteractiveInput.checked;
    cancel.disabled = false;
    document.querySelectorAll('.zli-single-export').forEach(button => { button.disabled = true; });
    const oldScroll = { x: window.scrollX, y: window.scrollY };
    let root;
    try {
      report(selectedAnswer ? '正在展开并导出选中的回答（含问题）…' : '从列表顶部开始收集，请暂时不要切换排序或操作页面…');
      const header = await questionHeader(Boolean(selectedAnswer));
      let items;
      if (selectedAnswer) {
        if (!selectedAnswer.isConnected) throw new Error('该回答已从页面移除，请重新点击。');
        selectedAnswer.scrollIntoView({ block: 'center', behavior: 'instant' });
        await expand(selectedAnswer);
        check();
        const item = snapshot(selectedAnswer, 1);
        if (!item) throw new Error('未能读取这条回答的正文，请展开后重试。');
        await enrichHTMLInteractions(selectedAnswer, item);
        items = [item];
        updateProgress(1, 1);
      } else {
        items = await collect(count);
      }
      check();
      if (!items.length) throw new Error('没有找到回答。请先登录知乎，并在普通提问页面显示回答列表后重试。');
      if (items.length < count && !window.confirm(`请求前 ${count} 条，但仅收集到 ${items.length} 条。可能已到末尾、加载超时或需要登录。是否仅导出这 ${items.length} 条？`)) {
        throw new Error('已停止，未导出不完整结果。');
      }
      root = node('section');
      root.id = 'zli-stage';
      root.style.width = `${CONFIG.WIDTH}px`;
      root.append(header, ...items);
      const failed = await inlineImages(root);
      check();
      setProgressStage('render');
      document.body.append(root);
      if (document.fonts?.ready) await document.fonts.ready;
      window.scrollTo(0, 0);
      await pause(150);
      const results = ['png', 'webp'].includes(CONFIG.FORMAT) ? await render(root, mode) : await exportDocument(root, CONFIG.FORMAT);
      const interactionWarnings = root.querySelectorAll('.zli-incomplete').length;
      if (!results) { finishProgress('cancelled'); report('已取消导出。可以调整格式后重试。'); return; }
      check();
      root.remove();
      root = null;
      const format = results[0]?.extension === 'zip' ? 'ZIP' : CONFIG.FORMAT.toUpperCase();
      const details = results[0].extension === 'zip' ? `离线HTML＋${results[0].mediaCount}个音视频文件，解压后打开index.html` : CONFIG.FORMAT === 'pdf' ? `${results[0].pages} 页高清截图PDF` : ['html', 'svg'].includes(CONFIG.FORMAT) ? '保留真实文字及内嵌图片' : results[0].notice ? `输出 ${results[0].width} × ${results[0].height} 像素；${results[0].notice}` : `输出宽度 ${results[0].width} 像素，${CONFIG.SCALE}倍清晰度，无自动降采样`;
      finishProgress('ready');
      const bytes = results.reduce((sum, result) => sum + result.blob.size, 0);
      const info = `共 ${items.length} 条回答，${results.length} ${['png', 'webp'].includes(CONFIG.FORMAT) ? '张' : '个'} ${format}，${details}。耗时 ${elapsedText()}，总大小 ${formatBytes(bytes)}。${interactionWarnings ? ` 有 ${interactionWarnings} 处交互内容未完整保存，文件内已标注。` : ''}${failed ? ` ${failed} 张图片加载失败，图中已标记。` : ''}`;
      const label = selectedAnswer ? `回答${answerID(selectedAnswer) || '单条'}_含问题` : `前${items.length}条回答`;
      const filename = `知乎_${activeQuestion}_${label}_${new Date().toISOString().slice(0, 10)}.${results[0].extension || CONFIG.FORMAT}`;
      showPreview(results, filename, info);
      report(info);
    } catch (error) {
      if (cancelled) { finishProgress('cancelled'); report('已取消导出。'); }
      else { finishProgress('error'); console.error('[知乎长图]', error); report(error.message || '导出失败，请刷新页面后重试。'); }
    } finally {
      clearInterval(progressTimer);
      root?.remove();
      window.scrollTo(oldScroll.x, oldScroll.y);
      busy = false;
      if (launcher) launcher.textContent = '长图工具';
      start.disabled = Boolean(detailAnswerID());
      splitStart.disabled = Boolean(detailAnswerID());
      countInput.disabled = scaleInput.disabled = formatInput.disabled = false;
      syncFormatUI();
      cancel.disabled = true;
      document.querySelectorAll('.zli-single-export').forEach(button => { button.disabled = false; });
    }
  }

  function syncPanelVisibility() {
    const id = questionID();
    const eligible = Boolean(id && (!CONFIG.QUESTION_ID || id === String(CONFIG.QUESTION_ID)));
    panel.style.display = eligible && !CONFIG.PANEL_COLLAPSED ? 'block' : 'none';
    launcher.style.display = eligible && CONFIG.PANEL_COLLAPSED ? 'block' : 'none';
    launcher.setAttribute('aria-expanded', String(!CONFIG.PANEL_COLLAPSED));
  }

  function setPanelCollapsed(collapsed) {
    CONFIG.PANEL_COLLAPSED = collapsed;
    syncPanelVisibility();
    saveSettings();
    if (collapsed) launcher.focus();
    else collapseButton.focus();
  }

  const css = document.createElement('style');
  css.textContent = `
    #zli-panel{position:fixed;right:20px;bottom:24px;z-index:2147483647;width:252px;padding:16px;background:#fff;border:1px solid #ddd;border-radius:12px;box-shadow:0 4px 24px #0002;color:#222;font:14px/1.6 sans-serif}
    #zli-panel strong{display:block;margin-bottom:8px}#zli-panel button,#zli-preview button,.zli-download{cursor:pointer;border:0;border-radius:6px;padding:8px 12px;margin:4px;background:#056de8;color:#fff;font:14px sans-serif;text-decoration:none;display:inline-block}
    #zli-panel button:disabled{opacity:.45;cursor:default}#zli-panel p{font-size:12px;margin:8px 0 0;overflow-wrap:anywhere}
    #zli-panel label{display:inline-flex;align-items:center;gap:5px;margin:0 8px 8px 0;font-size:13px}#zli-panel input,#zli-panel select{box-sizing:border-box;border:1px solid #bbb;border-radius:4px;background:white;color:#222;padding:4px;font:13px sans-serif}#zli-panel input{width:64px}#zli-panel select{width:56px}
    #zli-panel .zli-title{display:flex;align-items:center;gap:5px;white-space:nowrap;margin-bottom:12px}#zli-panel .zli-title label{margin:0;font:inherit;gap:5px}#zli-panel .zli-title input{width:58px;font:inherit;font-weight:600;text-align:center}
    #zli-panel .zli-title{padding-right:22px}#zli-panel .zli-collapse{position:absolute;right:6px;top:6px;width:26px;height:26px;padding:0;margin:0;border:0;border-radius:5px;background:transparent;color:#718096;font:24px/26px sans-serif;text-align:center}#zli-panel .zli-collapse:hover{background:#edf3fc;color:#056de8}
    #zli-launcher{position:fixed;right:20px;bottom:24px;z-index:2147483647;min-width:76px;padding:11px 14px;border:1px solid #056de8;border-radius:24px;background:#056de8;color:#fff;box-shadow:0 3px 14px #0003;cursor:pointer;font:14px/1.5 sans-serif}#zli-launcher:focus-visible,#zli-panel .zli-collapse:focus-visible{outline:3px solid #8cbafb;outline-offset:2px}
    #zli-panel .zli-format-row{display:flex;margin:10px 0 0;gap:8px}#zli-panel .zli-format-row select{flex:1;width:auto}#zli-panel .zli-format-note{font-size:12px;color:#68758a}
    #zli-panel :is(.zli-pdf-options,.zli-html-options){display:flex;align-items:flex-start;margin:9px 0 0;gap:7px;white-space:normal}#zli-panel :is(.zli-pdf-options,.zli-html-options) input{width:15px;height:15px;margin-top:3px;flex-shrink:0;accent-color:#056de8}#zli-panel :is(.zli-pdf-options,.zli-html-options) small{display:block;color:#68758a;font-size:11px}
    #zli-progress{margin-top:12px;padding:10px;background:#f2f6fd;border-radius:8px;font-size:12px}#zli-progress[hidden]{display:none}#zli-progress .zli-steps{display:flex;justify-content:space-between;color:#8590a0;font-size:11px;margin-bottom:8px}#zli-progress [data-active=true]{color:#056de8;font-weight:600}#zli-progress [data-done=true]{color:#168457}#zli-progress progress{display:block;width:100%;height:7px;margin:8px 0;accent-color:#056de8}#zli-progress [data-role=time]{color:#68758a}#zli-progress[data-state=error]{background:#fff0ef}#zli-progress[data-state=ready]{background:#edf8f1}.zli-file-size{font-size:12px;color:#68758a;margin-left:8px}
    .zli-single-export{display:inline-block;flex-shrink:0;margin:0 0 0 10px;padding:5px 10px;border:1px solid #b8d4fa;border-radius:5px;background:#eef5ff;color:#056de8;font:13px/1.5 sans-serif;cursor:pointer;vertical-align:middle}.zli-single-export:disabled{opacity:.45;cursor:default}.zli-single-export:focus-visible{outline:2px solid #056de8;outline-offset:2px}
    #zli-stage{position:absolute!important;left:0!important;top:0!important;z-index:2147483646;box-sizing:border-box;background:white;color:#222;font:18px/1.85 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;padding:36px;pointer-events:none}
    #zli-stage *{box-sizing:border-box;content-visibility:visible!important}#zli-stage header{padding-bottom:24px}#zli-stage h1{font-size:28px;line-height:1.5;font-weight:700;margin:0 0 16px}
    #zli-stage .zli-answer{padding:28px 0;border-top:2px solid #ddd}#zli-stage h2{font-size:22px;font-weight:700;margin:0 0 8px}#zli-stage .zli-author{font-size:18px;font-weight:600}
    #zli-stage .zli-meta{font-size:13px;color:#666;overflow-wrap:anywhere;margin:8px 0}#zli-stage .zli-note{background:#fff6df;color:#775416;padding:10px;font-size:14px}
    #zli-stage .zli-body{margin-top:20px;height:auto!important;max-height:none!important;overflow:visible!important;mask-image:none!important;-webkit-mask-image:none!important;white-space:normal;overflow-wrap:anywhere}
    #zli-stage .zli-body *{max-height:none!important}#zli-stage p{margin:0 0 16px}#zli-stage img{max-width:100%!important;height:auto!important;display:block;object-fit:contain;margin:12px auto}
    #zli-stage img[eeimg]{display:inline-block;margin:0;vertical-align:middle}#zli-stage figure{width:auto!important;max-width:100%;margin:18px 0}#zli-stage a{color:#175199;overflow-wrap:anywhere}
    #zli-stage pre{white-space:pre-wrap!important;word-break:break-word;background:#f5f5f5;padding:14px;font:14px/1.6 monospace}#zli-stage blockquote{border-left:4px solid #ddd;padding-left:16px;color:#555}#zli-stage table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:14px}#zli-stage td,#zli-stage th{border:1px solid #ddd;padding:6px;overflow-wrap:anywhere}
    #zli-stage .zli-media video,#zli-stage .zli-media audio{display:block;width:100%;max-width:100%;margin:12px 0}
    #zli-stage .zli-annotations{margin-top:24px}#zli-stage .zli-annotations details{border:1px solid #ddd;padding:12px;margin:10px 0;border-radius:6px}
    #zli-stage .zli-annotations summary{cursor:pointer;color:#175199}#zli-stage .zli-comment{border-top:1px solid #eee;padding:10px 0}#zli-stage .zli-underlined,#zli-stage .zli-original-underline{border-bottom:1px dashed #68758a}
    #zli-stage ul,#zli-stage ol{padding-left:1.8em}#zli-stage .RichText img{max-width:100%!important}#zli-stage .RichText{font-size:18px;line-height:1.85}
    #zli-preview{position:fixed;inset:0;z-index:2147483647;background:#0009;overflow:auto;padding:32px;color:#222;font:14px/1.6 sans-serif}#zli-preview .zli-preview-box{max-width:960px;margin:auto;background:white;padding:20px;border-radius:10px}#zli-preview h3{font-size:20px;font-weight:700}#zli-preview .zli-image-box{overflow:auto;max-height:70vh;margin:12px 0 24px}#zli-preview img{display:block;max-width:100%;height:auto;margin-top:12px}
  `;
  document.head.append(css);
  panel = node('div');
  panel.id = 'zli-panel';
  collapseButton = node('button', '×', 'zli-collapse');
  collapseButton.type = 'button';
  collapseButton.title = '收起到右下角';
  collapseButton.setAttribute('aria-label', '收起长图工具');
  collapseButton.onclick = () => setPanelCollapsed(true);
  panel.append(collapseButton);
  const heading = node('strong', undefined, 'zli-title');
  heading.title = '作者：jasonLi';
  heading.append(node('span', '知乎回答长图 ·'));
  const countLabel = node('label', '前');
  countInput = node('input');
  countInput.type = 'number';
  countInput.min = '1';
  countInput.step = '1';
  countInput.id = 'zli-answer-count';
  countInput.setAttribute('aria-label', '截取前几条回答');
  countInput.value = String(CONFIG.ANSWER_COUNT);
  countInput.addEventListener('input', saveSettings);
  countInput.addEventListener('change', saveSettings);
  countLabel.append(countInput, node('span', '条'));
  heading.append(countLabel);
  panel.append(heading);
  const scaleLabel = node('label', '清晰度');
  scaleInput = node('select');
  scaleInput.id = 'zli-scale';
  scaleInput.setAttribute('aria-label', '清晰度');
  for (const value of [1, 2, 3, 4]) {
    const option = node('option', `${value}倍`);
    option.value = String(value);
    scaleInput.append(option);
  }
  scaleInput.value = String(CONFIG.SCALE);
  scaleInput.addEventListener('change', saveSettings);
  scaleLabel.append(scaleInput);
  panel.append(scaleLabel);
  start = node('button', '单张高清长图');
  start.onclick = () => run();
  splitStart = node('button', '高清分图');
  splitStart.onclick = () => run('split');
  cancel = node('button', '取消');
  cancel.disabled = true;
  cancel.onclick = () => { cancelled = true; report('正在取消，请等待当前处理结束…'); };
  status = node('p', '先选择需要的回答排序，再点击生成。运行时请保持页面打开。');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  progressArea = node('div'); progressArea.id = 'zli-progress'; progressArea.hidden = true;
  const steps = node('div', undefined, 'zli-steps');
  for (const label of ['收集回答', '加载图片', '生成文件', '完成']) { const step = node('span', label); step.dataset.step = label; steps.append(step); }
  progressLabel = node('div'); progressLabel.setAttribute('data-role', 'stage');
  progressBar = node('progress'); progressBar.max = 100; progressBar.setAttribute('aria-label', '当前阶段进度');
  progressTime = node('div'); progressTime.setAttribute('data-role', 'time'); progressTime.setAttribute('aria-live', 'off');
  progressArea.append(steps, progressLabel, progressBar, progressTime);
  panel.append(progressArea);
  panel.append(start, splitStart, cancel, status);
  const formatLabel = node('label', '导出格式', 'zli-format-row');
  formatInput = node('select');
  formatInput.id = 'zli-format';
  formatInput.setAttribute('aria-label', '导出格式');
  for (const [value, text] of [['png', 'PNG · 无损长图'], ['svg', 'SVG · 文字可缩放'], ['html', 'HTML · 离线网页'], ['pdf', 'PDF · 分页文档'], ['webp', 'WebP · 压缩长图']]) {
    const option = node('option', text); option.value = value; formatInput.append(option);
  }
  formatInput.value = ['png', 'svg', 'html', 'pdf', 'webp'].includes(CONFIG.FORMAT) ? CONFIG.FORMAT : 'png';
  formatInput.onchange = () => { syncFormatUI(); saveSettings(); };
  formatLabel.append(formatInput);
  formatNote = node('p', undefined, 'zli-format-note');
  panel.insertBefore(formatLabel, status);
  pdfOptions = node('label', undefined, 'zli-pdf-options');
  pdfKeepInput = node('input');
  pdfKeepInput.type = 'checkbox';
  pdfKeepInput.id = 'zli-pdf-keep-images';
  pdfKeepInput.setAttribute('aria-label', '图片不跨页');
  pdfKeepInput.checked = CONFIG.PDF_KEEP_IMAGES;
  pdfKeepInput.onchange = saveSettings;
  const pdfDescription = node('span', '图片不跨页');
  pdfDescription.append(node('small', '放不下移到下一页；超高图片等比缩小'));
  pdfOptions.append(pdfKeepInput, pdfDescription);
  panel.insertBefore(pdfOptions, status);
  htmlOptions = node('label', undefined, 'zli-html-options');
  htmlOptions.id = 'zli-html-options';
  htmlInteractiveInput = node('input'); htmlInteractiveInput.type = 'checkbox';
  htmlInteractiveInput.id = 'zli-html-interactive';
  htmlInteractiveInput.setAttribute('aria-label', '包含音视频、划线评论和回复');
  htmlInteractiveInput.checked = CONFIG.HTML_INTERACTIVE;
  htmlInteractiveInput.onchange = saveSettings;
  const htmlDescription = node('span', '包含音视频、划线评论和回复');
  htmlDescription.append(node('small', '音视频下载到ZIP；单个32MB、合计128MB上限'));
  htmlOptions.append(htmlInteractiveInput, htmlDescription);
  panel.insertBefore(htmlOptions, status);
  panel.insertBefore(formatNote, status);
  panel.insertBefore(node('p', '数量、清晰度和格式会自动记住。', 'zli-format-note'), status);
  panel.insertBefore(progressArea, status);
  syncFormatUI();
  document.body.append(panel);
  launcher = node('button', '长图工具');
  launcher.id = 'zli-launcher';
  launcher.type = 'button';
  launcher.setAttribute('aria-label', '展开长图工具');
  launcher.setAttribute('aria-controls', 'zli-panel');
  launcher.setAttribute('data-html2canvas-ignore', 'true');
  launcher.onclick = () => setPanelCollapsed(false);
  document.body.append(launcher);
  panel.addEventListener('zli-show-panel', () => setPanelCollapsed(false));

  function syncRoute() {
    if (location.href !== lastURL) {
      if (busy) cancelled = true;
      lastURL = location.href;
    }
    syncPanelVisibility();
    start.disabled = busy || Boolean(detailAnswerID());
    splitStart.disabled = busy || Boolean(detailAnswerID());
    attachSingleButtons();
  }
  syncRoute();
  setInterval(syncRoute, 800); // 兼容知乎站内 SPA 导航。
})();
