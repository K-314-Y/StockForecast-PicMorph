/* User-supplied PNG composition, entirely in this browser tab.
 * Images remain in ephemeral browser memory. No upload or API writes. */
'use strict';

const $ = id => document.getElementById(id);
const canvas = $('previewCanvas');
const ctx = canvas.getContext('2d', {alpha:true});
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const keys = [
  ['base', 'partBase'], ['ready', 'partReady'], ['happy', 'partHappy'],
  ['cautious', 'partCautious'], ['outfit', 'partOutfit'], ['hair', 'partHair'],
];
const sampleUrls = Object.freeze({
  base:'/assets/hatchpet-demo-parts-body.webp',
  ready:'/assets/hatchpet-demo-parts-face-ready.webp',
  happy:'/assets/hatchpet-demo-parts-face-happy.webp',
  cautious:'/assets/hatchpet-demo-parts-face-cautious.webp',
});
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FRAME_SIDE = 1024;
const DEMOS_API = '/api/character-demos';
const DEMO_PARTS = {base:'body',ready:'ready',happy:'happy',cautious:'cautious'};
const MAX_DEMO_BYTES = 512 * 1024;
let galleryRequest;
let refreshWhenIdle = false;
let demoLoad;
let pack = null;
let epoch = 0;
let busy = false;
let paused = false;
let frame = 0;
let lastChange = 0;
let handle = 0;

function status(message, isError = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(isError);
}
function stopClock() {
  if (handle) cancelAnimationFrame(handle);
  handle = 0;
  lastChange = 0;
}
function release(bundle) {
  if (!bundle) return;
  for (const bitmap of new Set(Object.values(bundle.images))) bitmap.close();
}
function resetPack() {
  stopClock();
  if (pack) release(pack);
  pack = null;
  frame = 0;
  paused = false;
  $('pause').setAttribute('aria-pressed','false');
  $('pause').textContent = '停止する';
  $('pause').disabled = true;
  $('clear').disabled = true;
  $('stage').dataset.hasPreview = 'false';
  $('stage').dataset.single = 'false';
  $('stage').dataset.paused = 'false';
  $('frameInfo').textContent = '未読込';
  ctx.clearRect(0,0,canvas.width,canvas.height);
}
function setBusy(value) {
  busy = value;
  $('loadOwn').disabled = value;
  $('loadSample').disabled = value;
  $('loadGenerated').disabled = value;
  $('zipFile').disabled = value;
  for (const button of $('demoList').querySelectorAll('button')) {
    button.setAttribute('aria-disabled',String(value));
  }
  // Allow cancelling a slow decode or delayed sample request.
  $('clear').disabled = !value && !pack;
  if(!value && refreshWhenIdle) {
    refreshWhenIdle=false;
    void refreshGallery();
  }
}
function checkedOffset(id) {
  const value = Number($(id).value);
  return Number.isFinite(value) ? Math.max(-24,Math.min(24,value)) : 0;
}
function drawLayer(bitmap, frameIndex, dx=0, dy=0) {
  if (!bitmap) return;
  const width = pack.width;
  const height = pack.height;
  ctx.drawImage(bitmap,frameIndex*width,0,width,height,dx,dy,width,height);
}
function paint() {
  if (!pack) return;
  const mood = $('mood').value;
  const images = pack.images;
  ctx.clearRect(0,0,pack.width,pack.height);
  drawLayer(images.base,frame);
  drawLayer(images.outfit,frame);
  drawLayer(images[mood] || images.ready,frame,checkedOffset('faceX'),checkedOffset('faceY'));
  drawLayer(images.hair,frame);
  $('frameInfo').textContent = String(frame+1) + ' / ' + String(pack.frames) +
    ' コマ｜' + String(pack.width) + ' × ' + String(pack.height) + ' px' +
    (reduced.matches ? '｜静止表示（動きを減らす設定）' : '');
}
function nextFrame(time) {
  handle = 0;
  if (!pack || paused || document.hidden || pack.frames===1) return;
  // A browser's emulated reduced-motion setting may update matches without
  // dispatching a MediaQueryList change event. Reset on the next frame too.
  if (reduced.matches) {
    frame = 0;
    paint();
    return;
  }
  const duration = 1000 / Number($('fps').value);
  if (!lastChange) lastChange=time;
  if (time-lastChange >= duration) {
    frame=(frame+Math.floor((time-lastChange)/duration))%pack.frames;
    lastChange=time;
    paint();
  }
  handle=requestAnimationFrame(nextFrame);
}
function startClock() {
  stopClock();
  if (!pack) return;
  if (reduced.matches) frame=0;
  paint();
  if (!paused && !reduced.matches && !document.hidden && pack.frames===6) {
    handle=requestAnimationFrame(nextFrame);
  }
}
function hasAlpha(bitmap) {
  // Reject fully opaque face/overlay images: they would cover the character.
  const check=document.createElement('canvas');
  check.width=2;check.height=2;
  const c=check.getContext('2d',{willReadFrequently:true});
  const w=bitmap.width-1,h=bitmap.height-1;
  for (const [x,y] of [[0,0],[w,0],[0,h],[w,h]]) {
    c.clearRect(0,0,2,2);
    c.drawImage(bitmap,x,y,1,1,0,0,1,1);
    if (c.getImageData(0,0,1,1).data[3] < 245) return true;
  }
  return false;
}
async function decodeFile(file, label) {
  if (!file) return null;
  if (file.type!=='image/png' && file.type!=='image/webp') {
    throw Error(label+'はPNGかWebPにしてください。');
  }
  if (!file.size || file.size>MAX_BYTES) {
    throw Error(label+'は5MB以下にしてください。');
  }
  try {return await createImageBitmap(file);}
  catch {throw Error(label+'を画像として読み込めませんでした。');}
}
async function decodeSample(url,label) {
  const response=await fetch(url,{mode:'same-origin',cache:'no-store'});
  if (!response.ok) throw Error(label+'のデモ素材を取得できません。');
  const blob=await response.blob();
  if (blob.type!=='image/webp' || blob.size>MAX_BYTES) throw Error('デモ素材の形式またはサイズが不正です。');
  try {return await createImageBitmap(blob);}
  catch {throw Error(label+'のデモ素材を開けません。');}
}
function inspect(images, frames) {
  const body=images.base,ready=images.ready;
  if (!body || !ready) throw Error('体と通常の顔の2枚は必須です。');
  if (![1,6].includes(frames) || body.width%frames!==0) {
    throw Error('体画像は指定コマ数で割り切れる横幅にしてください。');
  }
  const width=body.width/frames,height=body.height;
  if (width<32 || height<32 || width>MAX_FRAME_SIDE || height>MAX_FRAME_SIDE) {
    throw Error('1コマは32〜1024pxの縦横にしてください。');
  }
  for (const [name,bitmap] of Object.entries(images)) {
    if (bitmap.width!==body.width || bitmap.height!==body.height) {
      throw Error(name+'のキャンバス寸法が体と違います。同じ寸法でPNGを書き出してください。');
    }
    if (name!=='base' && !hasAlpha(bitmap)) {
      throw Error(name+'には透明背景が必要です。完成絵をそのまま重ねると二重に見えます。');
    }
  }
  return {images,frames,width,height};
}
async function loadPack(isSample) {
  if (busy) return;
  clearDemoStatus();
  const myEpoch=++epoch;
  const temp={};
  setBusy(true);
  status(isSample?'デモのPNGパーツを読み込んでいます…':'選んだPNGをブラウザ内で確認しています…');
  try {
    const frames=isSample?6:Number($('frames').value);
    for (const [key,input] of keys) {
      const file=$(input).files?.[0];
      if (isSample && sampleUrls[key]) {
        temp[key]=await decodeSample(sampleUrls[key],key);
      } else if (!isSample && file) {
        temp[key]=await decodeFile(file,key);
      }
      if (epoch!==myEpoch) return;
    }
    // Transfer bitmaps to a separate object before releasing temporary references.
    const next=inspect({...temp},frames);
    if (epoch!==myEpoch) return;
    displayLoaded(next,frames);
    for (const key of Object.keys(temp)) delete temp[key]; // ownership transferred to pack
    status(isSample ?
      'デモを読み込みました。表情と動きの切替を試してください。' :
      'PNGを読み込みました。画像はこのブラウザ内のみで使用し、保存していません。');
  } catch (error) {
    if (epoch===myEpoch) status(error.message || '画像を読み込めません。',true);
  } finally {
    release({images:temp});
    if (epoch===myEpoch) setBusy(false);
  }
}

// Generated six-frame (3 columns x 2 rows) sheet import. The four sources
// never leave this browser. Coordinates tuned to this original lavender chibi;
// this is NOT an automatic Live2D/face-part extractor.
const generatedKeys = [
  ['base','generatedBase'],['ready','generatedReady'],
  ['happy','generatedHappy'],['cautious','generatedCautious'],
];
const GRID_COLUMNS=3, GRID_ROWS=2, TARGET_CELL=256;
function generatedSheetGeometry(bitmap) {
  if (bitmap.width % GRID_COLUMNS || bitmap.height % GRID_ROWS ||
      bitmap.width / GRID_COLUMNS !== bitmap.height / GRID_ROWS) {
    throw Error('画像生成の素材は3列×2行で、各コマが正方形の画像にしてください。');
  }
  const side=bitmap.width / GRID_COLUMNS;
  if (side<64 || side>1024) throw Error('元の1コマは64〜1024pxにしてください。');
  return side;
}
async function normalizeGenerated(bitmap, layer, side) {
  const strip=document.createElement('canvas');
  strip.width=TARGET_CELL*6;strip.height=TARGET_CELL;
  const c=strip.getContext('2d',{alpha:true,willReadFrequently:true});
  c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';
  for (let i=0;i<6;i++) {
    const x=(i%GRID_COLUMNS)*side;
    const y=Math.floor(i/GRID_COLUMNS)*side;
    if (layer==='base') {
      c.drawImage(bitmap,x,y,side,side,i*TARGET_CELL,0,TARGET_CELL,TARGET_CELL);
    } else {
      // Original face panels are wider than the blank face in the body sheet.
      // 169,75,174 are original 512px-cell alignment coordinates, kept proportional.
      const destX=i*TARGET_CELL+(169/512)*TARGET_CELL;
      const destY=(75/512)*TARGET_CELL;
      const length=(174/512)*TARGET_CELL;
      c.drawImage(bitmap,x,y,side,side,destX,destY,length,length);
    }
  }
  // Suppress near-transparent generation haze without erasing the foreground.
  const pixels=c.getImageData(0,0,strip.width,strip.height);
  for(let i=3;i<pixels.data.length;i+=4){
    const a=pixels.data[i];
    pixels.data[i]=Math.max(0,Math.min(255,Math.round((a-14)*255/170)));
  }
  c.putImageData(pixels,0,0);
  return await createImageBitmap(strip);
}
function displayLoaded(next,frames,isSample=false){
  if(pack)release(pack);
  pack=next;
  $('frames').value=String(frames);
  canvas.width=next.width;canvas.height=next.height;
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  frame=0;paused=false;
  $('pause').disabled=false;
  $('pause').setAttribute('aria-pressed','false');
  $('pause').textContent='停止する';
  $('clear').disabled=false;
  $('stage').dataset.hasPreview='true';
  $('stage').dataset.single=String(frames===1);
  $('stage').dataset.paused='false';
  $('faceX').value='0';$('faceY').value='0';
  startClock();
}
async function loadGeneratedSheets(){
  if(busy)return;
  clearDemoStatus();
  const myEpoch=++epoch;
  const raw={};const transformed={};
  setBusy(true);
  status('3列×2行の生成画像から、体と顔の6コマを組み立てています…');
  try{
    for(const [name,id] of generatedKeys){
      const file=$(id).files?.[0];
      if(file)raw[name]=await decodeFile(file,name);
      if(myEpoch!==epoch)return;
    }
    if(!raw.base||!raw.ready){
      throw Error('生成画像の「顔なしの体」と「通常の顔」の両方を選んでください。');
    }
    const side=generatedSheetGeometry(raw.base);
    for(const [name,image] of Object.entries(raw)){
      if(image.width!==raw.base.width||image.height!==raw.base.height){
        throw Error(name+'の画像サイズが体と違います。4枚を同じ3×2シートで作ってください。');
      }
      if(name!=='base'&&!hasAlpha(image)){
        throw Error(name+'の顔画像は透明背景が必要です。');
      }
      transformed[name]=await normalizeGenerated(image,name,side);
      if(myEpoch!==epoch)return;
    }
    const next=inspect({...transformed},6);
    if(myEpoch!==epoch)return;
    displayLoaded(next,6);
    for(const name of Object.keys(transformed))delete transformed[name];
    status('生成したキャラの6コマを合成しました。表情切替とまばたきを確認できます。位置にズレがあれば顔のX・Yで調整してください。');
  }catch(error){
    if(myEpoch===epoch)status(error.message||'生成画像を開けませんでした。',true);
  }finally{
    release({images:raw});
    release({images:transformed});
    if(myEpoch===epoch)setBusy(false);
  }
}
$('loadGenerated').addEventListener('click',loadGeneratedSheets);

function demoStatus(message) {
  $('demoStatus').textContent=message;
}
function clearDemoStatus() {
  if(!$('demoList').hidden) demoStatus('');
}

// The gallery uses only same-origin GETs. Each response is local generated
// material, and image requests begin only after an explicit selection.
function fetchDemo(url,signal) {
  return fetch(url,{mode:'same-origin',method:'GET',cache:'no-store',redirect:'error',signal});
}

async function refreshGallery() {
  if(busy) return;
  galleryRequest?.abort();
  const list=$('demoList');
  const request=new AbortController();
  galleryRequest=request;
  const timeout=setTimeout(()=>request.abort(),8000);
  try {
    const response=await fetchDemo(DEMOS_API,request.signal);
    if(!response.ok) throw Error('Catalog unavailable');
    const entries=await response.json();
    if(request!==galleryRequest || busy) return;
    if(!Array.isArray(entries) || entries.length>32) throw Error('Invalid catalog');
    const cards=document.createDocumentFragment();
    const seen=new Set();
    for(const item of entries) {
      if(typeof item?.name!=='string' || typeof item.generated_id!=='string' ||
          item.generated_id.length!==35 || !/^cp_[0-9a-f]{32}$/.test(item.generated_id) ||
          !['original-template','user-png'].includes(item.engine) || seen.has(item.generated_id)) continue;
      seen.add(item.generated_id);
      const card=document.createElement('li');
      const name=document.createElement('strong');
      name.textContent=item.name;
      const engine=document.createElement('small');
      engine.textContent=item.engine==='user-png' ? '登録したPNGキャラ' : '図形で作ったデモ';
      const button=document.createElement('button');
      button.type='button';
      button.textContent='このキャラで試す';
      button.setAttribute('aria-label',button.textContent+' · '+item.name);
      button.setAttribute('aria-disabled',String(busy));
      button.addEventListener('click',()=>void loadRegisteredDemo(item,button));
      card.append(name,engine,button);
      cards.append(card);
    }
    list.replaceChildren(cards);
    list.hidden=!list.children.length;
    demoStatus(list.hidden?'登録されたデモはありません。':'');
  } catch {
    if(request===galleryRequest && !busy) {
      list.replaceChildren();
      list.hidden=true;
      demoStatus('登録デモを確認できません。ZIPやPNGでも試せます。');
    }
  } finally {
    clearTimeout(timeout);
    if(request===galleryRequest) {
      galleryRequest=undefined;
      // Initial discovery can finish during a manual load before any cards exist.
      if(busy && list.hidden) refreshWhenIdle=true;
    }
  }
}

async function loadRegisteredDemo(item,button) {
  if(busy) return;
  const myEpoch=++epoch;
  const controller=new AbortController();
  demoLoad={controller,button};
  const timeout=setTimeout(()=>controller.abort(),8000);
  const temp={};
  setBusy(true);
  $('cancelDemo').hidden=false;
  demoStatus('「'+item.name+'」のパーツを読み込んでいます…');
  try {
    for(const [key,part] of Object.entries(DEMO_PARTS)) {
      const response=await fetchDemo(DEMOS_API+'/'+item.generated_id+'/'+part+'.png',controller.signal);
      if(!response.ok) throw Error('Part unavailable');
      const blob=await response.blob();
      if(blob.type!=='image/png' || !blob.size || blob.size>MAX_DEMO_BYTES) throw Error('Invalid atlas');
      if(myEpoch!==epoch) return;
      temp[key]=await decodeFile(blob,part);
      if(myEpoch!==epoch) return;
      if(controller.signal.aborted || temp[key].width!==1152 || temp[key].height!==208) {
        throw Error('Invalid atlas');
      }
    }
    const next=inspect({...temp},6);
    displayLoaded(next,6);
    for(const key of Object.keys(temp)) delete temp[key];
    demoStatus('「'+item.name+'」を読み込みました。表情を切り替えて試せます。');
    status('登録済みキャラの6コマを表示しています。');
  } catch {
    if(myEpoch===epoch) demoStatus('デモを読み込めませんでした。ZIPやPNGでも試せます。');
  } finally {
    clearTimeout(timeout);
    release({images:temp});
    if(myEpoch===epoch) {
      finishDemoLoad();
      setBusy(false);
    }
  }
}

function finishDemoLoad() {
  if(!demoLoad) return;
  const cancel=$('cancelDemo');
  if(document.activeElement===cancel && demoLoad.button.isConnected) demoLoad.button.focus();
  demoLoad.controller.abort();
  demoLoad=undefined;
  cancel.hidden=true;
}

$('cancelDemo').addEventListener('click',()=>{
  ++epoch;
  finishDemoLoad();
  setBusy(false);
  demoStatus('デモの読み込みを中止しました。');
});
void refreshGallery();
window.addEventListener('pageshow',event=>{
  if(event.persisted) void refreshGallery();
});

// Users select ONE archive; file change automatically loads the four atlases.
// The archive never leaves this browser and no extracted files are saved.
async function importCharacterZip(file){
  if(!file || busy)return;
  clearDemoStatus();
  const myEpoch=++epoch;
  const temp={};
  setBusy(true);
  status('ZIPから体と表情4種類を自動で読み込んでいます…');
  try{
    const {extractCharacterZip}=await import('/parts-lab/zip-import.mjs');
    if(myEpoch!==epoch)return;
    const files=await extractCharacterZip(file);
    if(myEpoch!==epoch)return;
    for(const kind of ['base','ready','happy','cautious']){
      const name=kind==='base'?'body':kind;
      if(files[name])temp[kind]=await decodeFile(files[name],name);
      if(myEpoch!==epoch)return;
    }
    const next=inspect({...temp},6);
    if(myEpoch!==epoch)return;
    displayLoaded(next,6);
    for(const key of Object.keys(temp))delete temp[key];
    status('ZIPのキャラを自動で再生しています。体＋表情を読み込みました。表情を変えて確認してください。');
  }catch(error){
    if(myEpoch===epoch)status(error.message||'ZIPを読み込めませんでした。',true);
  }finally{
    release({images:temp});
    if(myEpoch===epoch){
      $('zipFile').value='';
      setBusy(false);
    }
  }
}
$('zipFile').addEventListener('change',()=>{
  const file=$('zipFile').files?.[0];
  if(file)void importCharacterZip(file);
});

$('loadOwn').addEventListener('click',()=>loadPack(false));
$('loadSample').addEventListener('click',()=>loadPack(true));
$('clear').addEventListener('click',()=>{
  ++epoch;
  finishDemoLoad();
  clearDemoStatus();
  setBusy(false);
  resetPack();
  for (const [,input] of [...keys,...generatedKeys]) $(input).value='';
  $('zipFile').value='';
  status('プレビューを解除しました。画像データは保存していません。');
});
$('pause').addEventListener('click',()=>{
  if (!pack) return;
  paused=!paused;
  $('pause').setAttribute('aria-pressed',String(paused));
  $('pause').textContent=paused?'再生する':'停止する';
  $('stage').dataset.paused=String(paused);
  startClock();
});
$('mood').addEventListener('change',paint);
$('fps').addEventListener('change',startClock);
for (const id of ['faceX','faceY']) $(id).addEventListener('input',paint);
$('frames').addEventListener('change',()=>{
  if (pack || busy) {
    ++epoch;
    if(demoLoad) demoStatus('デモの読み込みを中止しました。');
    else clearDemoStatus();
    finishDemoLoad();setBusy(false);resetPack();
    status('コマ数が変わりました。画像をもう一度読み込んでください。');
  }
});
for (const [,input] of keys) $(input).addEventListener('change',()=>{
  if (pack) status('新しい画像を選びました。「選んだPNGで試す」で反映されます。');
});
document.addEventListener('visibilitychange',startClock);
reduced.addEventListener('change',startClock);
window.addEventListener('pagehide',()=>{
  galleryRequest?.abort();galleryRequest=undefined;
  refreshWhenIdle=false;
  finishDemoLoad();
  ++epoch;resetPack();setBusy(false);
});
