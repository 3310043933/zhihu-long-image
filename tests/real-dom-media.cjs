// 复现用户提供的结构；测试内容为合成数据，不提交用户页面或媒体。
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=process.env.ZLI_TEST_OUTPUT||path.join(root,'test-results');
fs.mkdirSync(output,{recursive:true});
const cover='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const fixture=`<!doctype html><meta charset="utf-8"><h1 class="QuestionHeader-title">问题视频与段评结构回归</h1>
<div class="QuestionRichText"><div><span class="RichText"><p>问题描述含视频</p><div class="player-shell"><div class="site-player"><div><video src="https://vdn3.vzuu.com/sample.mp4"></video></div><div class="site-cover"><img src="${cover}"><div>00:30</div><svg><circle r="10"></circle></svg></div><div class="site-controls">站点控制条</div></div></div></span></div></div>
<main class="Question-main"><div class="QuestionAnswers-answers"><article class="AnswerItem" data-aid="2106863218618536261"><span class="AuthorInfo-name">合成作者</span><div class="RichContent-inner"><span class="RichText"><p data-pid="4N41DVjC"><span class="highlight-wrap other has-end-icon" data-highlight-id="2109214065251836545#g#%5B%224N41DVjC%22%2C0%2C%224N41DVjC%22%2C4%5D">划线原文</span></p></span></div></article>
<article class="AnswerItem" data-aid="2106863218618536262"><span class="AuthorInfo-name">合成作者乙</span><div class="RichContent-inner"><span class="RichText"><p>回答视频卡片</p><a class="video-box" data-video-id="" data-lens-id="2106361399379235705" href="https://link.zhihu.com/?target=https%3A%2F%2Fwww.zhihu.com%2Fvideo%2F2106361399379235705">尚未播放的视频</a></span></div></article></div></main>`;
function extractZip(bytes) {
 const files=new Map();let at=0;
 while(bytes.readUInt32LE(at)===0x04034b50){assert.equal(bytes.readUInt16LE(at+8),0);const n=bytes.readUInt16LE(at+26),x=bytes.readUInt16LE(at+28),size=bytes.readUInt32LE(at+18),start=at+30+n+x;files.set(bytes.subarray(at+30,at+30+n).toString(),bytes.subarray(start,start+size));at=start+size;}
 assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);return files;
}
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE}:{channel:'chromium'})});
 try {
  const page=await browser.newPage();const apiCalls=[];
  await page.route('https://www.zhihu.com/**',route=>{
   const req=route.request(),url=new URL(req.url());
   if(!url.pathname.startsWith('/api/'))return route.fulfill({contentType:'text/html;charset=utf-8',body:fixture});
   apiCalls.push(url.pathname);
   if(url.pathname.endsWith('/play_info')) {
    const data=req.postDataJSON();assert.ok(['question','answer'].includes(data.content_type_str));assert.equal(data.video_id,'2106361399379235705');
    return route.fulfill({json:{video_play:{playlist:{mp4:[{bitrate:100,url:['https://vdn3.vzuu.com/sample.mp4']}]}}}});
   }
   if(url.pathname.endsWith('/segment/root_comment')){assert.equal(url.searchParams.get('segment_id'),'2109214065251836545');return route.fulfill({json:{data:[{id:'r1',content:'<p>真实标识对应的段评</p>',author:{name:'合成评论者'}}],paging:{is_end:true}}});}
   throw new Error('Unexpected API '+url.pathname);
  });
  await page.goto('https://www.zhihu.com/question/2106361423706308654');
  let video,mime;
  if(process.env.ZLI_REAL_VIDEO_FILE){video=fs.readFileSync(process.env.ZLI_REAL_VIDEO_FILE);mime='video/mp4';}
  else {video=Buffer.from(await page.evaluate(async()=>{
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const stream=canvas.captureStream(0),chunks=[];
   const recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),finished=new Promise(resolve=>{recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=resolve;});recorder.start();
   for(let i=0;i<5;i++){await new Promise(resolve=>setTimeout(resolve,100));canvas.getContext('2d').fillRect(i,0,20,20);stream.getVideoTracks()[0].requestFrame();}
   recorder.stop();await finished;stream.getTracks().forEach(t=>t.stop());return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  }));mime='video/webm';}
  await page.evaluate(({bytes,mime})=>{
   window.downloadCount=0;window.GM_getValue=()=>({FORMAT:'html',ANSWER_COUNT:2,HTML_INTERACTIVE:true});window.GM_setValue=()=>{};
   window.GM_xmlhttpRequest=options=>{window.downloadCount++;setTimeout(()=>options.onload({status:200,response:new Blob([new Uint8Array(bytes)],{type:mime})}),1);return {abort(){}};};
  },{bytes:[...video],mime});
  await page.addScriptTag({path:path.join(root,'zhihu-long-image.user.js')});
  await page.getByRole('button',{name:'导出 HTML',exact:true}).click();await page.locator('#zli-preview').waitFor({timeout:30000});
  const archive=Buffer.from(await page.evaluate(async()=>[...new Uint8Array(await(await fetch(document.querySelector('#zli-preview a').href)).arrayBuffer())]));
  fs.writeFileSync(path.join(output,'real-dom-export.zip'),archive);const files=extractZip(archive);
  const main=files.get('index.html').toString('utf8');assert.ok(!main.includes('站点控制条'));assert.ok(!main.includes('class="site-cover"'));assert.ok(!main.includes('00:30'));
  assert.ok(main.includes('真实标识对应的段评'));assert.ok(!main.includes('未取得段落标识'));assert.ok(!main.includes('已下载，可离线播放'));
  assert.equal([...files.keys()].filter(name=>name.startsWith('media/')).length,1,'同一媒体只下载一次');assert.equal(await page.evaluate(()=>window.downloadCount),1);
  const dir=path.join(output,'real-dom-extracted');for(const[name,data]of files){const target=path.join(dir,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);}
  const offline=await browser.newPage();await offline.goto(pathToFileURL(path.join(dir,'index.html')).href);
  assert.equal(await offline.locator('video').count(),2);assert.equal(await offline.locator('header video').count(),1);assert.equal(await offline.locator('header img').count(),0);
  assert.match(await offline.locator('header video').getAttribute('poster'),/^data:image\//);
  assert.equal(await offline.locator('.zli-answer').first().locator('video').count(),0,'只有划线文字的回答不应出现视频');
  await offline.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>v.readyState>=1&&v.videoWidth>0));
  const metadata=await offline.locator('video').first().evaluate(v=>({duration:v.duration,width:v.videoWidth,height:v.videoHeight}));assert.ok(metadata.duration>0);
  if(process.env.ZLI_REAL_VIDEO_FILE){assert.ok(metadata.duration>30&&metadata.duration<31);assert.equal(metadata.width,720);assert.equal(metadata.height,1280);}
  await offline.locator('video').first().evaluate(async v=>{await v.play();});await offline.waitForFunction(()=>document.querySelector('video').currentTime>0.1);
  await offline.locator('video').first().evaluate(v=>v.pause());
  await offline.screenshot({path:path.join(output,'real-dom-offline.png'),fullPage:true});
  // 尚未播放的问题视频卡片，只有data-lens-id/跳转href也要解析。
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>{document.querySelector('.QuestionRichText .RichText').innerHTML='<a class="video-box" data-video-id="" data-lens-id="2106361399379235705" href="https://link.zhihu.com/?target=https%3A%2F%2Fwww.zhihu.com%2Fvideo%2F2106361399379235705"></a>';});
  await page.getByRole('button',{name:'导出此回答',exact:true}).first().click();await page.locator('#zli-preview').waitFor();
  assert.equal(apiCalls.filter(p=>p.endsWith('/play_info')).length,2);
  console.log('PASS: 问题原生播放器去壳与本地封面、data-highlight-id段评、data-lens-id/跳转链接、媒体去重、ZIP解压后自动读取时长及真实播放。',metadata);
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
