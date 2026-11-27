// 在隔离浏览器模拟知乎响应，验证离线HTML的媒体、段评/回复和失败提示。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.ZLI_TEST_OUTPUT || path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const wave = Buffer.alloc(46); wave.write('RIFF'); wave.writeUInt32LE(38,4); wave.write('WAVEfmt ',8); wave.writeUInt32LE(16,16); wave.writeUInt16LE(1,20); wave.writeUInt16LE(1,22); wave.writeUInt32LE(8000,24); wave.writeUInt32LE(16000,28); wave.writeUInt16LE(2,32); wave.writeUInt16LE(16,34); wave.write('data',36); wave.writeUInt32LE(2,40);
function readZIP(buffer) {
  const entries = new Map(); let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset+8),0);
    const size=buffer.readUInt32LE(offset+18), n=buffer.readUInt16LE(offset+26), extra=buffer.readUInt16LE(offset+28);
    const name=buffer.subarray(offset+30,offset+30+n).toString('utf8');
    assert.ok(!name.includes('..') && !name.startsWith('/'));
    const start=offset+30+n+extra, data=buffer.subarray(start,start+size);
    let crc=0xffffffff; for(const byte of data) {crc^=byte;for(let k=0;k<8;k++) crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}
    assert.equal((crc^0xffffffff)>>>0,buffer.readUInt32LE(offset+14),'ZIP CRC');
    entries.set(name,data);offset=start+size;
  }
  const end=buffer.length-22;assert.equal(buffer.readUInt32LE(end),0x06054b50);assert.equal(buffer.readUInt16LE(end+10),entries.size);
  assert.equal(buffer.readUInt32LE(end+16),offset);
  return entries;
}
const fixture = `<!doctype html><meta charset="utf-8"><h1 class="QuestionHeader-title">HTML交互导出测试</h1><main class="Question-main"><div class="QuestionAnswers-answers"><article class="AnswerItem" data-aid="303"><div class="AuthorInfo"><span class="AuthorInfo-name">测试作者</span></div><div class="RichContent-inner"><div class="RichText">
<p><span data-segment-id="seg1">划线原文一</span></p><p><span data-seg-id="seg2">受限段落</span></p>
<p data-pid="p1">状态中的划线文字</p>
<audio src="data:audio/wav;base64,${wave.toString('base64')}" autoplay onplay="window.pwned=1"></audio>
<video src="https://vdn.vzuu.com/clip.webm" autoplay loop></video><video src="blob:https://www.zhihu.com/expired"></video>
<a class="video-box" href="https://www.zhihu.com/video/123">视频卡片</a><p>回答末尾</p>
</div></div></article></div></main><script id="js-initialData" type="application/json">${JSON.stringify({initialState:{entities:{answers:{303:{reaction:{segments:[{segId:'seg3',content:'状态中的划线文字',position:{start:{paragraph_id:'p1',offset:0},end:{paragraph_id:'p1',offset:8}}}]}}}}}})}</script>`;
(async () => {
  const extensionMode=process.env.ZLI_TEST_EXTENSION==='1';
  const launch={ ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : { channel: 'chromium' }), headless:true };
  const browser=extensionMode ? await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require('node:os').tmpdir(),'zli-html-')), {...launch,args:[`--disable-extensions-except=${path.join(root,'extension')}`,`--load-extension=${path.join(root,'extension')}`]}) : await chromium.launch(launch);
  try {
    const page = await browser.newPage({ viewport: { width:1280, height:1000 }, acceptDownloads:true });
    const requests=[];
    const comment=(id,content,extra={})=>({id,content,author:{name:'评论者'+id},...extra});
    await page.route('https://www.zhihu.com/**', async route => {
      const req=route.request(), url=new URL(req.url());
      if (!url.pathname.startsWith('/api/')) return route.fulfill({contentType:'text/html;charset=utf-8',body:fixture});
      requests.push({url:req.url(),method:req.method()});
      let data;
      if (url.pathname.endsWith('/play_info')) {
        assert.equal(req.method(),'POST'); assert.equal(req.postDataJSON().video_id,'123');
        data={video_play:{playlist:{mp4:[{bitrate:100,url:['https://vdn.vzuu.com/low.webm']},{bitrate:200,url:['https://vdn.vzuu.com/high.webm']}]}}};
      } else {
        assert.equal(req.method(),'GET');
        if (url.searchParams.get('segment_id')==='seg2') return route.fulfill({status:403,body:'login required'});
        if (url.pathname.endsWith('/root_comment')) {
          const segment=url.searchParams.get('segment_id');
          if(segment==='seg3') data={data:[],paging:{is_end:true}};
          else if (url.searchParams.get('offset')==='next') data={data:[comment('c1','重复根评论'),comment('c2','第二页根评论')],paging:{is_end:true}};
          else data={data:[comment('c1','<p>根评论正文<strong>加粗</strong><img src="https://evil.test/tracker" alt="[表情]"><script>window.pwned=1</script><a href="javascript:alert(1)">危险链接</a></p>',{child_comment_count:3,child_comments:[comment('r1','内嵌回复')]})],paging:{is_end:false,next:`https://www.zhihu.com${url.pathname}?segment_id=seg1&offset=next`}};
        } else if(url.pathname.endsWith('/child_comment')) {
          if(url.searchParams.get('offset')==='reply-next') data={data:[comment('r3','回复第二页')],paging:{is_end:true}};
          else data={data:[comment('r1','内嵌回复'),comment('r2','回复第一页',{reply_to_author:{name:'楼主'}})],paging:{is_end:false,next:`https://www.zhihu.com${url.pathname}?offset=reply-next`}};
        } else throw new Error('unexpected API '+req.url());
      }
      return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.addInitScript(() => {
      window.GM_getValue=(key,fallback)=>JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback));
      window.GM_setValue=(key,value)=>localStorage.setItem(key,JSON.stringify(value));
      window.GM_xmlhttpRequest=options=>{
        let aborted=false;
        setTimeout(()=>{ if(!aborted) options.onload({status:200,response:new Blob([new Uint8Array(window.fixtureVideoBytes)],{type:'video/webm'})}); },10);
        return {abort(){aborted=true;options.onabort?.();}};
      };
    });
    const load=async()=>{await page.goto('https://www.zhihu.com/question/123456');if(!extensionMode) await page.addScriptTag({path:path.join(root,'zhihu-long-image.user.js')});await page.locator('#zli-panel').waitFor();};
    await load();
    await page.evaluate(async()=>{
      const canvas=document.createElement('canvas'); canvas.width=64;canvas.height=64;
      const stream=canvas.captureStream(0), recorder=new MediaRecorder(stream,{mimeType:'video/webm'}), chunks=[];
      const finish=new Promise(resolve=>{recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=resolve;});
      recorder.start();
      for(let i=0;i<5;i++) { await new Promise(resolve=>setTimeout(resolve,100));const ctx=canvas.getContext('2d');ctx.fillStyle=i%2?'red':'blue';ctx.fillRect(0,0,64,64);stream.getVideoTracks()[0].requestFrame(); }
      await new Promise(resolve=>setTimeout(resolve,100));recorder.stop();await finish;stream.getTracks().forEach(t=>t.stop());
      window.fixtureVideoBytes=[...new Uint8Array(await new Blob(chunks).arrayBuffer())];
    });
    if(extensionMode) {
      const worker=browser.serviceWorkers()[0]||await browser.waitForEvent('serviceworker');
      const bytes=await page.evaluate(()=>window.fixtureVideoBytes);
      await worker.evaluate(bytes=>{
        globalThis.fetch=async(url,options)=>{
          if(new URL(url).hostname!=='vdn.vzuu.com') throw new Error('Unexpected media request');
          if(options.credentials!=='omit') throw new Error('Media request included credentials');
          return new Response(new Uint8Array(bytes),{headers:{'content-type':'video/webm'}});
        };
      },bytes);
    }
    assert.equal(await page.locator('#zli-html-options').isVisible(),false);
    await page.locator('#zli-format').selectOption('html');
    assert.equal(await page.locator('#zli-html-options').isVisible(),true);
    assert.equal(await page.locator('#zli-html-interactive').isChecked(),true);
    const exportHTML=async()=>{
      await page.getByRole('button',{name:'导出此回答',exact:true}).click();
      await page.locator('#zli-preview').waitFor({timeout:30000});
      const url=await page.locator('#zli-preview a').first().getAttribute('href');
      return Buffer.from(await page.evaluate(async url=>[...new Uint8Array(await (await fetch(url)).arrayBuffer())],url));
    };
    const zip=await exportHTML(); fs.writeFileSync(path.join(output,'interactive-export.zip'),zip);
    const entries=readZIP(zip);const html=entries.get('index.html').toString('utf8');
    assert.equal([...entries.keys()].filter(name=>name.startsWith('media/')).length,3);
    const extracted=path.join(output,'interactive-extracted');fs.mkdirSync(extracted,{recursive:true});
    for(const [name,data] of entries) {const target=path.join(extracted,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);}
    assert.deepEqual(entries.get('media/media-001.wav'),wave);
    assert.ok(!/<script\b|\son\w+=|javascript:/i.test(html));
    assert.match(html,/有|根评论正文/); assert.match(html,/回复未|已保存/);
    assert.match(await page.locator('#zli-preview').innerText(),/未完整保存/);
    const offline=await browser.newPage();
    const {pathToFileURL}=require('node:url');
    await offline.goto(pathToFileURL(path.join(extracted,'index.html')).href);
    assert.equal(await offline.locator('audio[controls]').count(),1);
    assert.equal(await offline.locator('video[controls]').count(),2);
    assert.equal(await offline.locator('video[autoplay],video[loop],audio[autoplay]').count(),0);
    assert.equal(await offline.locator('video[src="media/media-002.webm"]').count(),1);
    assert.equal(await offline.locator('video[src="media/media-003.webm"]').count(),1);
    assert.match(await offline.locator('body').innerText(),/临时 blob/);
    await offline.locator('audio').evaluate(el=>{el.preload='metadata';el.load();});
    await offline.waitForFunction(()=>document.querySelector('audio').readyState>=1);
    await offline.locator('video').first().evaluate(el=>{el.preload='metadata';el.load();});
    await offline.waitForFunction(()=>document.querySelector('video').readyState>=1);
    assert.equal(await offline.locator('.zli-underlined').count(),3,'段评位置可在副本中映射');
    const details=offline.locator('.zli-annotations > details'); assert.equal(await details.count(),3);
    await details.first().locator(':scope > summary').click();
    assert.equal(await details.first().getAttribute('open'),'');
    assert.match(await details.first().innerText(),/根评论正文/);
    const replies=details.first().locator('.zli-replies');await replies.locator('summary').click();
    assert.match(await replies.innerText(),/回复第二页/);assert.match(await replies.innerText(),/回复 楼主/);
    assert.equal(await details.first().locator('.zli-comment').count(),5,'2根评论+3回复，重复条目必须去重');
    await offline.locator('a[href="#zli-segment-303-1"]').click();
    assert.equal(new URL(offline.url()).hash,'#zli-segment-303-1');
    await offline.screenshot({path:path.join(output,'interactive-html.png'),fullPage:true});await offline.close();
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    if(!extensionMode) {
      await page.evaluate(()=>{window.mediaAborted=false;window.GM_xmlhttpRequest=()=>({abort(){window.mediaAborted=true;}});});
      await page.getByRole('button',{name:'导出此回答',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#zli-panel [role=status]').textContent.includes('正在下载离线音视频 2/'));
      await page.locator('#zli-panel').getByRole('button',{name:'取消',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#zli-progress').dataset.state==='cancelled');
      assert.equal(await page.evaluate(()=>window.mediaAborted),true);
      assert.equal(await page.locator('#zli-preview').count(),0,'取消不得生成部分ZIP');
    }
    await page.locator('#zli-html-interactive').uncheck();await load();
    assert.equal(await page.locator('#zli-format').inputValue(),'html');
    assert.equal(await page.locator('#zli-html-interactive').isChecked(),false);
    requests.length=0;
    const staticHTML=(await exportHTML()).toString('utf8');assert.equal(requests.length,0,'关闭交互后不得请求段评/播放信息');
    assert.ok(!/<audio\b|<video\b|class="zli-annotations"/.test(staticHTML));
    console.log('PASS: HTML专属选项和记忆、ZIP CRC和目录、真实音视频离线解码/失效入口、段评与回复分页去重、状态位置映射、失败摘要、无脚本和跟踪图、离线展开、关闭后零额外请求。');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
