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
const PART_WIDTH = 192, PART_HEIGHT = 208, MAX_INDEPENDENT_PARTS = 8;
const independentParts = [];
const SAVED_PARTS_API = '/api/independent-parts';
const EQUIPMENT_API = '/api/character-equipment/v1';
const MAX_SAVED_PNG = 1024 * 1024;
const savedPartButtons = [];
let savedListLoad;
let independentLoad;
let registeredDemo;
let equipmentRequest;
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
  cancelEquipmentRequest();
  registeredDemo=undefined;
  cancelIndependentRead();
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
  updateIndependentControls();
}
function setBusy(value) {
  busy = value;
  if (value) {
    cancelIndependentRead();
    cancelEquipmentRequest();
  }
  $('loadOwn').disabled = value;
  $('loadSample').disabled = value;
  $('loadGenerated').disabled = value;
  $('zipFile').disabled = value;
  for (const button of $('demoList').querySelectorAll('button')) {
    button.setAttribute('aria-disabled',String(value));
  }
  // Allow cancelling a slow decode or delayed sample request.
  $('clear').disabled = !value && !pack;
  updateIndependentControls();
  if(!value && refreshWhenIdle) {
    refreshWhenIdle=false;
    void refreshGallery();
  }
}
function checkedOffset(input) {
  const value = Number(input.value);
  return Number.isFinite(value) ? Math.max(-24,Math.min(24,value)) : 0;
}
function drawLayer(bitmap, frameIndex, dx=0, dy=0) {
  if (!bitmap) return;
  const width = pack.width;
  const height = pack.height;
  ctx.drawImage(bitmap,frameIndex*width,0,width,height,dx,dy,width,height);
}
function drawIndependent(anchor) {
  if (!fitsIndependentParts()) return;
  for (const part of independentParts) {
    if (part.visible && part.anchor===anchor) {
      drawLayer(part.bitmap,part.frames===6?frame:0,part.x,part.y);
    }
  }
}
function paint() {
  if (!pack) return;
  const mood = $('mood').value;
  const images = pack.images;
  ctx.clearRect(0,0,pack.width,pack.height);
  drawLayer(images.base,frame);
  drawIndependent('base');
  drawLayer(images.outfit,frame);
  drawIndependent('outfit');
  drawLayer(images[mood] || images.ready,frame,checkedOffset($('faceX')),checkedOffset($('faceY')));
  drawIndependent('face');
  drawLayer(images.hair,frame);
  drawIndependent('hair');
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

function fitsIndependentParts() {
  return pack?.width===PART_WIDTH && pack.height===PART_HEIGHT;
}
function independentStatus(message, isError=false) {
  $('independentStatus').textContent=message;
  $('independentStatus').dataset.error=String(isError);
}
function updateIndependentControls() {
  const compatible=fitsIndependentParts();
  const full=independentParts.length>=MAX_INDEPENDENT_PARTS;
  $('independentFiles').disabled=busy || Boolean(independentLoad || equipmentRequest) || !compatible || full;
  $('loadSavedParts').disabled=Boolean(savedListLoad || independentLoad?.controller || equipmentRequest);
  const transient=independentParts.some(part=>!part.catalogId);
  const equipmentReady=registeredDemo && compatible && !busy && !equipmentRequest && !independentLoad && !savedListLoad;
  $('restoreEquipment').disabled=!equipmentReady;
  $('saveEquipment').disabled=!equipmentReady || transient || registeredDemo.revision===null;
  $('equipmentHint').textContent=!registeredDemo ? '登録済みキャラを読み込むと利用できます。復元は手動です。' :
    transient ? '保存する前に、ファイルから読み込んだ一時パーツを取り外してください。' :
    '対象: '+registeredDemo.name+'。装備設定を保存し、復元はボタンで行います。';
  for (const {button,entry} of savedPartButtons) {
    button.setAttribute('aria-disabled',String(!canEquipSavedPart(entry)));
  }
  $('cancelIndependent').hidden=!independentLoad || independentLoad.cancelled;
  const notice=compatible ? (full ? 'パーツを取り外すと、別の画像を追加できます。' :
    pack.frames===1 ? 'キャラが1コマのため、横6コマのパーツは最初のコマを表示します。' : '') :
    '1コマが192×208のキャラを読み込むと、独立パーツを表示できます。';
  $('independentAvailability').textContent=notice;
  $('independentAvailability').hidden=!notice;
}
function cancelIndependentRead() {
  if (!independentLoad || independentLoad.cancelled) return;
  independentLoad.cancelled=true;
  independentLoad.controller?.abort();
  independentStatus('独立パーツの読み込みを中止しました。');
  updateIndependentControls();
}
function clearIndependentParts() {
  cancelIndependentRead();
  for (const part of independentParts) part.bitmap.close();
  independentParts.length=0;
  $('independentList').replaceChildren();
  $('independentFiles').value='';
  independentStatus('');
  updateIndependentControls();
}

function canEquipSavedPart(entry) {
  return fitsIndependentParts() && !busy && !independentLoad && !savedListLoad && !equipmentRequest &&
    independentParts.length<MAX_INDEPENDENT_PARTS && !independentParts.some(part=>part.catalogId===entry.part_id);
}

async function savedPartResponse(url, mime, limit, signal, sha256) {
  const response=await fetch(url,{method:'GET',mode:'same-origin',cache:'no-store',redirect:'error',signal,
    ...(sha256 ? {headers:{'X-Creature-Part-Preview':'1'}} : {})});
  return boundedPartResponse(response,mime,limit,sha256);
}

async function boundedPartResponse(response,mime,limit,sha256) {
  const length=response.headers.get('content-length')??'';
  if (!response.ok || response.headers.get('content-type')?.split(';')[0]!==mime ||
      !/^\d+$/.test(length) || Number(length)<=0 || Number(length)>limit || !response.body ||
      (sha256 && response.headers.get('x-creature-part-sha256')!==sha256)) {
    await response.body?.cancel();
    throw Object.assign(Error('装備またはパーツの応答を確認できません。'),{status:response.status});
  }
  const bytes=new Uint8Array(Number(length));
  const reader=response.body.getReader();
  let offset=0;
  try {
    while (true) {
      const {value,done}=await reader.read();
      if (done) break;
      if (offset+value.length>bytes.length) throw Error('保存済みパーツの応答が大きすぎます。');
      bytes.set(value,offset);
      offset+=value.length;
    }
    if (offset!==bytes.length) throw Error('保存済みパーツの応答が途中で切れています。');
    return bytes;
  } finally {
    await reader.cancel().catch(()=>{});
  }
}

function cancelSavedList() {
  if (!savedListLoad) return;
  savedListLoad.abort();
  savedListLoad=undefined;
  $('savedPartsStatus').textContent='';
  updateIndependentControls();
}

async function showSavedParts() {
  if (savedListLoad || independentLoad?.controller || equipmentRequest) return;
  const controller=new AbortController();
  savedListLoad=controller;
  const timeout=setTimeout(()=>controller.abort(),9000);
  const notice=$('savedPartsStatus');
  const list=$('savedPartsList');
  notice.textContent='保存済みパーツを確認しています…';
  savedPartButtons.length=0;
  list.replaceChildren();
  updateIndependentControls();
  try {
    const bytes=await savedPartResponse(SAVED_PARTS_API,'application/json',16384,controller.signal);
    const {parts}=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if (savedListLoad!==controller || controller.signal.aborted) return;
    if (!Array.isArray(parts) || parts.length>32) throw Error('Invalid part list');
    const fragment=document.createDocumentFragment();
    const seen=new Set();
    const buttons=[];
    for (const entry of parts) {
      if (typeof entry?.part_id!=='string' || entry.part_id.length!==35 || !/^pt_[0-9a-f]{32}$/.test(entry.part_id) ||
          seen.has(entry.part_id) || !['base','outfit','face','hair'].includes(entry.layer_anchor) ||
          typeof entry.kind_id!=='string' || entry.kind_id.length>64 || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(entry.kind_id) ||
          typeof entry.source_id!=='string' || entry.source_id.length!==35 || !/^cp_[0-9a-f]{32}$/.test(entry.source_id) ||
          typeof entry.image_sha256!=='string' || entry.image_sha256.length!==64 || !/^[0-9a-f]{64}$/.test(entry.image_sha256)) {
        throw Error('Invalid part metadata');
      }
      seen.add(entry.part_id);
      const row=document.createElement('li');
      const title=document.createElement('strong');
      title.textContent=entry.kind_id;
      const details=document.createElement('p');
      details.className='hint';
      details.textContent='出典 '+entry.source_id+' · '+entry.layer_anchor+' の上';
      const button=document.createElement('button');
      button.type='button';
      button.textContent='このパーツを重ねて試す';
      button.setAttribute('aria-label',button.textContent+' · '+entry.kind_id+' · '+entry.part_id);
      button.addEventListener('click',()=>void equipSavedPart(entry));
      row.append(title,details,button);
      fragment.append(row);
      buttons.push({button,entry});
    }
    savedPartButtons.push(...buttons);
    list.append(fragment);
    notice.textContent=parts.length ? parts.length+'件の保存済みパーツがあります。' : '保存済みパーツはまだありません。';
  } catch {
    if (savedListLoad===controller) notice.textContent='保存済みパーツを確認できませんでした。';
  } finally {
    clearTimeout(timeout);
    if (savedListLoad===controller) {
      savedListLoad=undefined;
      updateIndependentControls();
    }
  }
}

async function equipSavedPart(entry) {
  if (!canEquipSavedPart(entry)) return;
  const load={cancelled:false,controller:new AbortController()};
  independentLoad=load;
  const timeout=setTimeout(()=>load.controller.abort(),9000);
  updateIndependentControls();
  independentStatus('選んだ保存済みパーツを読み込んでいます…');
  let bitmap;
  try {
    bitmap=await decodeSavedPart(entry,load.controller.signal);
    if (load.cancelled) return;
    addIndependentPart(bitmap,6,entry.kind_id,entry);
    bitmap=undefined;
    paint();
    independentStatus(entry.kind_id+' を一時装備しました。');
  } catch {
    if (!load.cancelled) independentStatus('保存済みパーツを表示できませんでした。一覧を確認し直してください。',true);
  } finally {
    bitmap?.close();
    clearTimeout(timeout);
    finishIndependentRead();
  }
}

async function decodeSavedPart(entry,signal) {
  const bytes=await savedPartResponse(SAVED_PARTS_API+'/'+entry.part_id+'/part.png',
    'image/png',MAX_SAVED_PNG,signal,entry.image_sha256);
  if (signal.aborted) throw Error('Part request cancelled');
  const {width,height,frames}=independentImageSize(bytes.buffer,'image/png');
  if (frames!==6) throw Error('Invalid saved part dimensions');
  const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
  try {
    if (signal.aborted || bitmap.width!==width || bitmap.height!==height) throw Error('Invalid saved bitmap');
    checkIndependentAlpha(bitmap,frames);
    return bitmap;
  } catch(error) {
    bitmap.close();
    throw error;
  }
}

function cancelEquipmentRequest() {
  equipmentRequest?.abort();
  equipmentRequest=undefined;
  $('equipmentStatus').textContent='';
}

function parseEquipment(bytes, id) {
  const {schema,character_id,revision,parts}=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if (schema!==1 || character_id!==id || !Number.isSafeInteger(revision) || revision<0 ||
      !Array.isArray(parts) || parts.length>MAX_INDEPENDENT_PARTS || (revision===0 && parts.length)) {
    throw Error('Invalid equipment response');
  }
  const ids=new Set();
  for (const part of parts) {
    if (typeof part?.part_id!=='string' || part.part_id.length!==35 || !/^pt_[0-9a-f]{32}$/.test(part.part_id) ||
        ids.has(part.part_id) || !['base','outfit','face','hair'].includes(part.layer_anchor) || typeof part.visible!=='boolean' ||
        ![part.x,part.y].every(n=>Number.isInteger(n) && Math.abs(n)<=24) ||
        typeof part.image_sha256!=='string' || part.image_sha256.length!==64 || !/^[0-9a-f]{64}$/.test(part.image_sha256)) {
      throw Error('Invalid equipment part');
    }
    ids.add(part.part_id);
  }
  return {revision,parts};
}

async function equipmentAction(action) {
  const demo=registeredDemo;
  if (!demo || !fitsIndependentParts() || equipmentRequest || independentLoad || savedListLoad ||
      (action!=='revision' && busy)) return;
  if (action==='save' && (demo.revision===null || independentParts.some(part=>!part.catalogId))) return;
  const controller=new AbortController();
  equipmentRequest=controller;
  const {signal}=controller;
  const timeout=setTimeout(()=>controller.abort(),action==='restore'?75000:18000);
  const notice=$('equipmentStatus');
  const current=()=>equipmentRequest===controller && registeredDemo===demo;
  const staged=[];
  const url=EQUIPMENT_API+'/'+demo.id;
  updateIndependentControls();
  notice.textContent=action==='save'?'装備設定を保存しています…':'保存されている装備設定を確認しています…';
  try {
    let bytes;
    if (action==='save') {
      const parts=independentParts.map(part=>({part_id:part.catalogId,image_sha256:part.imageSha256,
        layer_anchor:part.anchor,x:part.x,y:part.y,visible:part.visible}));
      const response=await fetch(url,{method:'POST',mode:'same-origin',cache:'no-store',redirect:'error',signal,
        headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_revision:demo.revision,parts})});
      bytes=await boundedPartResponse(response,'application/json',4096);
    } else {
      bytes=await savedPartResponse(url,'application/json',4096,signal);
    }
    if (!current()) return;
    if (signal.aborted) throw Error('Equipment request timed out');
    const record=parseEquipment(bytes,demo.id);
    if (action==='save' && record.revision!==demo.revision+1) throw Error('Invalid saved revision');
    if (action==='restore') {
      for (const part of record.parts) {
        const bitmap=await decodeSavedPart(part,signal);
        staged.push({part,bitmap});
        if (!current()) return;
        if (signal.aborted) throw Error('Equipment restore timed out');
      }
      clearIndependentParts();
      for (const item of staged) {
        const label=savedPartButtons.find(saved=>saved.entry.part_id===item.part.part_id)?.entry.kind_id??item.part.part_id;
        addIndependentPart(item.bitmap,6,label,item.part);
        item.bitmap=undefined;
      }
      paint();
    }
    demo.revision=record.revision;
    notice.textContent=action==='save'?'装備設定を'+record.parts.length+'件保存しました。' :
      action==='restore'?'装備設定を'+record.parts.length+'件復元しました。' :
      record.revision===0?'このキャラに保存済みの装備設定はありません。':'保存済みの装備設定があります。復元はボタンで行います。';
  } catch(error) {
    if (current()) {
      if (action==='save') demo.revision=null;
      notice.textContent=error?.status===409 ? '別の操作で装備設定が更新されました。復元してから再度編集してください。' :
        action==='save'?'保存結果を確認できませんでした。復元して設定を確認してください。':'装備設定を確認または復元できませんでした。';
    }
  } finally {
    for (const {bitmap} of staged) bitmap?.close();
    clearTimeout(timeout);
    if (current()) {
      equipmentRequest=undefined;
      updateIndependentControls();
    }
  }
}

// Inspect the encoded dimensions before decoding to bound decoded memory.
// Only a single PNG or WebP image (one cell or a horizontal atlas) is accepted.
function independentImageSize(buffer, mime) {
  const bytes=new Uint8Array(buffer);
  const view=new DataView(buffer);
  const tag=offset=>String.fromCharCode(...bytes.subarray(offset,offset+4));
  const badImage=()=>Error('正常な透過PNGまたはWebPを選んでください。');
  const animated=()=>Error('アニメーション画像は使えません。静止画か横6コマの画像を選んでください。');
  let width,height;
  if (bytes.length>=33 && (!mime || mime==='image/png') &&
      view.getUint32(0)===0x89504e47 && view.getUint32(4)===0x0d0a1a0a &&
      view.getUint32(8)===13 && tag(12)==='IHDR') {
    width=view.getUint32(16);height=view.getUint32(20);
    let hasData=false, complete=false;
    for (let offset=33;offset+12<=bytes.length;) {
      const size=view.getUint32(offset), type=tag(offset+4);
      offset+=12+size;
      if (offset>bytes.length) throw badImage();
      if (type==='acTL') throw animated();
      if (type==='IDAT') hasData=true;
      if (type==='IEND') {complete=size===0 && offset===bytes.length;break;}
    }
    if (!hasData || !complete) throw badImage();
  } else if (bytes.length>=25 && (!mime || mime==='image/webp') &&
             tag(0)==='RIFF' && tag(8)==='WEBP' && view.getUint32(4,true)+8===bytes.length) {
    const chunk=tag(12), size=view.getUint32(16,true);
    if (20+size>bytes.length) throw badImage();
    if (chunk==='VP8X' && size===10) {
      if (bytes[20]&2) throw animated();
      width=1+view.getUint16(24,true)+bytes[26]*65536;
      height=1+view.getUint16(27,true)+bytes[29]*65536;
    } else if (chunk==='VP8L' && size>=5 && bytes[20]===47) {
      const bits=view.getUint32(21,true);
      width=1+(bits&0x3fff);height=1+((bits>>>14)&0x3fff);
    } else if (chunk==='VP8 ') {
      throw Error('透明背景のあるWebPを選んでください。');
    } else throw badImage();
  } else throw badImage();
  if (height!==PART_HEIGHT || (width!==PART_WIDTH && width!==PART_WIDTH*6)) {
    throw Error('サイズは192×208か、横6コマの1152×208にしてください。');
  }
  return {width,height,frames:width/PART_WIDTH};
}
function checkIndependentAlpha(bitmap, frames) {
  const sample=document.createElement('canvas');
  sample.width=PART_WIDTH;sample.height=PART_HEIGHT;
  const check=sample.getContext('2d',{willReadFrequently:true});
  let visible=false;
  for (let i=0;i<frames;i++) {
    check.clearRect(0,0,PART_WIDTH,PART_HEIGHT);
    check.drawImage(bitmap,i*PART_WIDTH,0,PART_WIDTH,PART_HEIGHT,0,0,PART_WIDTH,PART_HEIGHT);
    const pixels=check.getImageData(0,0,PART_WIDTH,PART_HEIGHT).data;
    let transparent=false;
    for (let j=3;j<pixels.length;j+=4) {
      transparent ||= pixels[j]===0;
      visible ||= pixels[j]>0;
      if (transparent && visible) break;
    }
    if (!transparent) throw Error('各コマに透明な背景が必要です。');
  }
  if (!visible) throw Error('画像に表示できるパーツがありません。');
}
function addIndependentPart(bitmap, frames, name, entry) {
  const row=$('independentRow').content.firstElementChild.cloneNode(true);
  row.querySelector('legend').textContent=name;
  const part={bitmap,frames,visible:entry?.visible??true,anchor:entry?.layer_anchor??'hair',catalogId:entry?.part_id,
    imageSha256:entry?.image_sha256,x:entry?.x??0,y:entry?.y??0};
  const visible=row.querySelector('[name=visible]');
  const anchor=row.querySelector('[name=anchor]');
  anchor.value=part.anchor;
  visible.checked=part.visible;
  visible.addEventListener('change',()=>{part.visible=visible.checked;paint();});
  anchor.addEventListener('change',()=>{part.anchor=anchor.value;paint();});
  for (const axis of ['x','y']) {
    const input=row.querySelector('[name='+axis+']');
    input.value=String(part[axis]);
    input.addEventListener('input',()=>{part[axis]=Math.trunc(checkedOffset(input));paint();});
    input.addEventListener('change',()=>{input.value=String(part[axis]);});
  }
  const remove=row.querySelector('button');
  remove.setAttribute('aria-label',name+'を取り外す');
  remove.addEventListener('click',()=>{
    const neighbor=row.nextElementSibling || row.previousElementSibling;
    independentParts.splice(independentParts.indexOf(part),1);
    bitmap.close();
    row.remove();
    independentStatus(name+'を取り外しました。');
    updateIndependentControls();
    const origin=savedPartButtons.find(item=>item.entry.part_id===part.catalogId)?.button;
    const fallback=origin ?? ($('independentFiles').disabled ? $('independentTitle') : $('independentFiles'));
    (neighbor?.querySelector('button') || fallback).focus();
    paint();
  });
  independentParts.push(part);
  $('independentList').append(row);
}
function finishIndependentRead() {
  independentLoad=undefined;
  const wasFocused=document.activeElement===$('cancelIndependent');
  updateIndependentControls();
  if (wasFocused) ($('independentFiles').disabled ? $('independentTitle') : $('independentFiles')).focus();
}
async function loadIndependentParts(files) {
  const load={cancelled:false};
  independentLoad=load;
  updateIndependentControls();
  independentStatus('独立パーツを読み込んでいます…');
  const errors=[];
  let added=0;
  try {
    for (const file of files) {
      let bitmap;
      try {
        if (!file.size || file.size>MAX_BYTES) throw Error('画像は1枚5MB以下にしてください。');
        const buffer=await file.arrayBuffer();
        if (load.cancelled) return;
        const {width,height,frames}=independentImageSize(buffer,file.type);
        try {bitmap=await createImageBitmap(file);}
        catch {throw Error('画像として読み込めませんでした。');}
        if (load.cancelled) return;
        if (bitmap.width!==width || bitmap.height!==height) throw Error('画像の寸法が一致しません。');
        checkIndependentAlpha(bitmap,frames);
        addIndependentPart(bitmap,frames,file.name);
        bitmap=undefined;
        added++;
        paint();
      } catch (error) {
        if (load.cancelled) return;
        errors.push(file.name+'：'+error.message);
      } finally {
        bitmap?.close();
      }
    }
    independentStatus([added ? added+'個のパーツを追加しました。' : '',...errors].join(' '),errors.length>0);
  } finally {
    finishIndependentRead();
  }
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
function displayLoaded(next,frames,demo){
  if (registeredDemo || demo) clearIndependentParts();
  registeredDemo=demo ? {id:demo.generated_id,name:demo.name,revision:null} : undefined;
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
  updateIndependentControls();
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
    displayLoaded(next,6,item);
    for(const key of Object.keys(temp)) delete temp[key];
    void equipmentAction('revision');
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
$('independentFiles').addEventListener('change',event=>{
  const input=event.currentTarget;
  if (input.disabled || !input.files?.length) return;
  if (input.files.length>MAX_INDEPENDENT_PARTS-independentParts.length) {
    input.value='';
    independentStatus('独立パーツは合計8個まで追加できます。選ぶ枚数を減らしてください。',true);
    return;
  }
  const files=Array.from(input.files);
  input.value='';
  void loadIndependentParts(files);
});
$('cancelIndependent').addEventListener('click',()=>{
  cancelIndependentRead();
  $('independentTitle').focus();
});
$('loadSavedParts').addEventListener('click',()=>void showSavedParts());
$('saveEquipment').addEventListener('click',()=>{
  if ($('saveEquipment').disabled) return;
  const count=independentParts.length;
  if (window.confirm(registeredDemo.name+' の装備設定を'+count+'件で置き換えますか？'+
      (count===0?' 保存済みの装備設定は空になります。':''))) void equipmentAction('save');
});
$('restoreEquipment').addEventListener('click',()=>{
  if ($('restoreEquipment').disabled) return;
  if (!independentParts.length || window.confirm('現在の試着を保存済み装備で置き換えますか？')) {
    void equipmentAction('restore');
  }
});

$('loadOwn').addEventListener('click',()=>loadPack(false));
$('loadSample').addEventListener('click',()=>loadPack(true));
$('clear').addEventListener('click',()=>{
  ++epoch;
  finishDemoLoad();
  clearDemoStatus();
  setBusy(false);
  resetPack();
  cancelSavedList();
  clearIndependentParts();
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
  cancelSavedList();
  savedPartButtons.length=0;
  $('savedPartsList').replaceChildren();
  $('savedPartsStatus').textContent='';
  clearIndependentParts();
  ++epoch;resetPack();setBusy(false);
});
