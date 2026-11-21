/* User-supplied PNG composition. Preview is browser-only until an explicit save. */
import {accessoryIdentityInput,BUILTIN_ACCESSORIES,MAX_EQUIPPED_ACCESSORIES,
  normalizeAccessoryDefinition} from './accessory-options.mjs';
import {checkOverlayHeader,hasOverlayAlpha,OVERLAY_MAX_SIDE,OVERLAY_POSITION,
  OVERLAY_SCALE,canvasPoint,layerOffsetLimit,overlayPosition,overlayRect,overlayValue} from './accessory-overlay.mjs';

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
let pack = null;
let currentZipFiles = null;
let visualEdit = null;
let editLoad = null;
let loadingEditPicker = false;
const zipLookFields=['zipHairStyle','zipExpression'];
const characterEndpoint='/api/imported-characters';
const accessoryEndpoint=characterEndpoint+'/accessories';
const methodLabels={
  bollinger_breakout:'ボリンジャーバンド',rsi_oversold:'RSI',
  macd_momentum:'MACD',moving_average_trend:'移動平均',
};
const builtinAccessories=new Map(BUILTIN_ACCESSORIES.map(item=>[item.id,item]));
const accessoryCatalog=new Map(builtinAccessories);
const manifestAccessories=new Map();
const accessoryOverlays=new Map();
let equippedIds=[];
let savingAccessory=false;
let epoch = 0;
let busy = false;
let registering = false;
let paused = false;
let frame = 0;
let lastChange = 0;
let handle = 0;
let drag = null;
let hitContext;
const canAttachOverlays=()=>Boolean(currentZipFiles || visualEdit);
const layerPicker=$('movePart');
const layerOffsets={base:{x:0,y:0},outfit:{x:0,y:0},face:{x:0,y:0},hair:{x:0,y:0}};
const offsetAxes=['x','y'];
const faceInputs={x:$('faceX'),y:$('faceY')};
const layerInputs={x:$('layerX'),y:$('layerY')};

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
  editLoad?.abort();
  editLoad=null;
  endDrag();
  stopClock();
  if (pack) release(pack);
  pack = null;
  $('mood').value='ready';
  hitContext=undefined;
  resetLayerPositions();
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
  if (busy) endDrag();
  refreshPartControls();
  $('loadOwn').disabled = value;
  $('loadSample').disabled = value;
  $('loadGenerated').disabled = value;
  $('zipFile').disabled = value;
  $('zipFrames').disabled = value;
  for(const id of ['zipName',...zipLookFields,'zipHairColor','zipClothingColor'])
    $(id).disabled=value || Boolean(visualEdit);
  $('mood').disabled=value;
  for(const option of $('mood').options)
    option.disabled=Boolean(visualEdit && !pack?.images[option.value]);
  $('frames').disabled=registering || Boolean(visualEdit);
  $('zipEquipment').disabled=value;
  $('cancelVisualEdit').disabled=value;
  refreshEditPicker();
  refreshZipTraitStatus();
  // Allow cancelling a slow decode or delayed sample request.
  $('clear').disabled = registering || Boolean(visualEdit) || (!value && !pack);
}
function setRegistering(value) {
  registering=value;
  for (const id of ['frames','fps',...keys.map(([,id])=>id),...generatedKeys.map(([,id])=>id)])
    $(id).disabled=value;
  $('pause').disabled=value || !pack;
  setBusy(value);
}
function layerBitmap(layer) {
  if (layer==='face') return pack?.images[$('mood').value] || pack?.images.ready;
  return pack?.images[layer];
}
function offsetBounds(layer) {
  const limit=layerOffsetLimit(layer,pack.width,pack.height);
  return {min:-limit,max:limit,initial:0};
}
function syncOffsetInputs(except) {
  const selected=layerOffsets[layerPicker.value];
  for (const axis of offsetAxes) {
    if (faceInputs[axis]!==except) faceInputs[axis].value=layerOffsets.face[axis];
    if (layerInputs[axis]!==except) layerInputs[axis].value=selected?.[axis]??0;
  }
}
function refreshPartControls() {
  const layer=layerPicker.value;
  const loaded=Boolean(layerBitmap(layer));
  const showOffsets=loaded && (layer!=='face' || Boolean(visualEdit));
  layerPicker.disabled=busy || !pack;
  for (const option of layerPicker.options) {
    option.disabled=option.value!=='accessory' && !layerBitmap(option.value);
  }
  $('layerOffsets').hidden=!showOffsets;
  $('resetLayerPosition').disabled=busy || !loaded;
  $('faceOffsets').hidden=Boolean(visualEdit);
  for (const axis of offsetAxes) {
    faceInputs[axis].disabled=busy || !pack || Boolean(visualEdit);
    const input=layerInputs[axis];
    input.disabled=busy || !showOffsets;
    if (loaded) {
      const {min,max}=offsetBounds(layer);
      input.min=min;
      input.max=max;
    }
  }
  syncOffsetInputs();
  updateDragAvailability();
}
function resetLayerPositions(savedOffsets) {
  for (const [layer,offset] of Object.entries(layerOffsets)) {
    const saved=savedOffsets?.[layer==='base'?'body':layer];
    offset.x=saved?.x??0;
    offset.y=saved?.y??0;
  }
  layerPicker.value='accessory';
  refreshPartControls();
}
function drawLayer(target, layer, frameIndex) {
  const bitmap=layerBitmap(layer);
  if (!bitmap) return;
  const {width,height}=pack;
  const {x,y}=layerOffsets[layer];
  target.drawImage(bitmap,frameIndex*width,0,width,height,x,y,width,height);
}
function drawCharacter(target,frameIndex) {
  target.clearRect(0,0,pack.width,pack.height);
  for (const layer of Object.keys(layerOffsets)) drawLayer(target,layer,frameIndex);
  for (const id of equippedIds) {
    const overlay=accessoryOverlays.get(id);
    if (overlay?.bitmap) target.drawImage(overlay.bitmap,...overlayRect(pack.width,pack.height,overlay));
  }
}
function paint() {
  if (!pack) return;
  drawCharacter(ctx,frame);
  $('frameInfo').textContent = String(frame+1) + ' / ' + String(pack.frames) +
    ' コマ｜' + String(pack.width) + ' × ' + String(pack.height) + ' px' +
    (reduced.matches ? '｜静止表示（動きを減らす設定）' : '');
}
function updateDragAvailability() {
  const editable=Boolean(pack && !busy);
  const accessory=layerPicker.value==='accessory';
  canvas.toggleAttribute('data-overlay-editable',editable && accessory && canAttachOverlays() &&
    equippedIds.some(id=>accessoryOverlays.get(id)?.bitmap));
  canvas.toggleAttribute('data-layer-editable',editable && !accessory && Boolean(layerBitmap(layerPicker.value)));
}
function pixelContext(width,height) {
  hitContext??=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
  hitContext.canvas.width=width;
  hitContext.canvas.height=height;
  return hitContext;
}
function hitLayer(layer,x,y) {
  const {width,height}=pack;
  const px=Math.floor(x), py=Math.floor(y);
  if (px<0 || py<0 || px>=width || py>=height) return null;
  const {x:dx,y:dy}=layerOffsets[layer];
  const sx=px-dx, sy=py-dy;
  if (sx<0 || sy<0 || sx>=width || sy>=height) return null;
  // Sample one pixel of the selected frame and layer, independent of overlap.
  const target=pixelContext(1,1);
  target.drawImage(layerBitmap(layer),frame*width+sx,sy,1,1,0,0,1,1);
  return target.getImageData(0,0,1,1).data[3]?{layer}:null;
}
function hitOverlay(x,y) {
  for (let index=equippedIds.length-1;index>=0;index--) {
    const overlay=accessoryOverlays.get(equippedIds[index]);
    if (!overlay?.bitmap) continue;
    const rect=overlayRect(pack.width,pack.height,overlay);
    const [left,top,width,height]=rect;
    const px=Math.floor(x-left), py=Math.floor(y-top);
    if (px<0 || py<0 || px>=width || py>=height) continue;
    // Read the alpha after resampling with the same settings as the portrait.
    const target=pixelContext(width,height);
    target.imageSmoothingQuality='high';
    target.drawImage(overlay.bitmap,0,0,width,height);
    if (target.getImageData(px,py,1,1).data[3]) return {overlay,rect};
  }
  return null;
}
function endDrag() {
  if (!drag) return;
  const {pointerId,attribute}=drag;
  drag=null;
  canvas.removeAttribute(attribute);
  if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
}
function pointerPoint(event) {
  const bounds=canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  return canvasPoint(event,bounds,canvas.width,canvas.height);
}
function moveDrag(event) {
  if (drag?.pointerId!==event.pointerId) return;
  const point=pointerPoint(event);
  if (!point) return;
  const {layer,overlay,rect,startPoint,startX,startY}=drag;
  const dx=point[0]-startPoint[0], dy=point[1]-startPoint[1];
  if (layer) {
    const bounds=offsetBounds(layer);
    const x=overlayValue(startX+dx,bounds);
    const y=overlayValue(startY+dy,bounds);
    const offset=layerOffsets[layer];
    if (offset.x===x && offset.y===y) return;
    offset.x=x;
    offset.y=y;
    syncOffsetInputs();
    paint();
    return;
  }
  const [left,top,width,height]=rect;
  const x=overlayPosition(left+dx,canvas.width-width,left,startX);
  const y=overlayPosition(top+dy,canvas.height-height,top,startY);
  if (overlay.x===x && overlay.y===y) return;
  overlay.x=x;
  overlay.y=y;
  for (const input of overlay.adjustments) {
    if (input.dataset.overlay!=='scale') input.value=overlay[input.dataset.overlay];
  }
  paint();
}
canvas.addEventListener('pointerdown',event=>{
  if (!event.isPrimary || event.button!==0 || drag) return;
  const startPoint=pointerPoint(event);
  if (!startPoint) return;
  const layer=layerPicker.value;
  const hit=canvas.hasAttribute('data-layer-editable')?hitLayer(layer,...startPoint):
    canvas.hasAttribute('data-overlay-editable')?hitOverlay(...startPoint):null;
  if (!hit) return;
  const {x:startX,y:startY}=hit.overlay ?? layerOffsets[layer];
  const attribute=hit.layer?'data-layer-dragging':'data-overlay-dragging';
  canvas.setPointerCapture(event.pointerId);
  drag={...hit,pointerId:event.pointerId,startPoint,startX,startY,attribute};
  canvas.setAttribute(attribute,'');
  event.preventDefault();
});
canvas.addEventListener('pointermove',moveDrag);
canvas.addEventListener('pointerup',event=>{
  if (drag?.pointerId!==event.pointerId) return;
  moveDrag(event);
  endDrag();
});
for (const type of ['pointercancel','lostpointercapture']) {
  canvas.addEventListener(type,event=>{
    if (drag?.pointerId===event.pointerId) endDrag();
  });
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
async function decodeFile(file, label, checkHeader) {
  if (!file) return null;
  if (file.type!=='image/png' && file.type!=='image/webp') {
    throw Error(label+'はPNGかWebPにしてください。');
  }
  if (!file.size || file.size>MAX_BYTES) {
    throw Error(label+'は5MB以下にしてください。');
  }
  if (checkHeader) await checkHeader(file);
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
  if (busy || visualEdit) return;
  currentZipFiles = null;
  clearZipEquipment();
  $('registerZip').disabled = true;
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
function displayLoaded(next,frames,offsets){
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
  resetLayerPositions(offsets);
  startClock();
}
async function loadGeneratedSheets(){
  if(busy||visualEdit)return;
  currentZipFiles=null;
  clearZipEquipment();
  $('registerZip').disabled=true;
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

// The ZIP is unpacked in this browser. Its optional manifest supplies declared
// appearance metadata; a visual AI classifier is NOT run.
function accessoryLabel({name,method}) {
  return name+'（'+methodLabels[method]+'）';
}
function overlayStatus(overlay,message,isError=false) {
  overlay.feedback.textContent=message;
  overlay.feedback.dataset.error=String(isError);
  overlay.remove.disabled=!overlay.bitmap && !overlay.pending;
  for (const input of overlay.adjustments) input.disabled=!overlay.bitmap;
}
function releaseOverlay(overlay) {
  if (drag?.overlay===overlay) endDrag();
  overlay.pending=null;
  overlay.bitmap?.close();
  overlay.bitmap=null;
  overlay.file=null;
  updateDragAvailability();
}
async function loadOverlay(id,overlay,file) {
  if (!file || busy || !canAttachOverlays() || accessoryOverlays.get(id)!==overlay) return;
  const request=Symbol();
  const chosenEpoch=epoch;
  overlay.pending=request;
  const isCurrent=()=>epoch===chosenEpoch && canAttachOverlays() && !busy &&
    accessoryOverlays.get(id)===overlay && overlay.pending===request;
  overlayStatus(overlay,'重ね絵を確認しています…');
  refreshZipTraitStatus();
  let bitmap;
  try {
    bitmap=await decodeFile(file,'重ね絵',async source=>{
      const buffer=await source.arrayBuffer();
      if (!isCurrent()) throw Error();
      checkOverlayHeader(buffer,source.type);
    });
    if (!isCurrent()) return;
    if (!bitmap.width || !bitmap.height || bitmap.width>OVERLAY_MAX_SIDE || bitmap.height>OVERLAY_MAX_SIDE)
      throw Error('重ね絵の縦横は1〜1024pxにしてください。');
    const check=document.createElement('canvas');
    check.width=bitmap.width;check.height=bitmap.height;
    const target=check.getContext('2d',{willReadFrequently:true});
    target.drawImage(bitmap,0,0);
    if (!hasOverlayAlpha(target.getImageData(0,0,check.width,check.height).data))
      throw Error('透明な背景が画像の1割以上あり、絵が描かれている素材を選んでください。');
    if (drag?.overlay===overlay) endDrag();
    overlay.bitmap?.close();
    overlay.bitmap=bitmap;
    overlay.file=file;
    bitmap=null;
    overlayStatus(overlay,'表示中：'+file.name);
    updateDragAvailability();
    paint();
  } catch (error) {
    if (isCurrent()) {
      overlayStatus(overlay,(error.message||'重ね絵を読み込めませんでした。')+
        (overlay.bitmap?' 以前の重ね絵を表示しています。':' 分析装備は有効です。'),true);
    }
  } finally {
    bitmap?.close();
    if (isCurrent()) {
      overlay.pending=null;
      overlay.remove.disabled=!overlay.bitmap;
      refreshZipTraitStatus();
    }
  }
}
function createOverlayRow(id) {
  const row=$('zipOverlayRow').content.firstElementChild.cloneNode(true);
  const file=row.querySelector('input[type=file]');
  const remove=row.querySelector('[data-action=remove-overlay]');
  const unequip=row.querySelector('[data-action=unequip]');
  const adjustments=row.querySelectorAll('[data-overlay]');
  const overlay={row,feedback:row.querySelector('[role=status]'),remove,adjustments,
    bitmap:null,file:null,pending:null};
  for (const input of adjustments) {
    const key=input.dataset.overlay;
    const bounds=key==='scale'?OVERLAY_SCALE:OVERLAY_POSITION;
    input.min=bounds.min;
    input.max=bounds.max;
    overlay[key]=bounds.initial;
    input.value=overlay[key];
    input.addEventListener('input',()=>{
      if (busy || !canAttachOverlays() || !overlay.bitmap) return;
      if (drag?.overlay===overlay) endDrag();
      overlay[key]=overlayValue(input.valueAsNumber,bounds);
      paint();
    });
    input.addEventListener('change',()=>{input.value=overlay[key];});
  }
  file.setAttribute('aria-describedby','zipOverlayHelp');
  file.addEventListener('change',()=>{
    const selected=file.files?.[0];
    file.value='';
    void loadOverlay(id,overlay,selected);
  });
  remove.addEventListener('click',()=>{
    if (busy || !canAttachOverlays() || accessoryOverlays.get(id)!==overlay) return;
    releaseOverlay(overlay);
    overlayStatus(overlay,'重ね絵を外しました。分析装備は有効です。');
    refreshZipTraitStatus();
    paint();
    file.focus();
  });
  unequip.addEventListener('click',()=>{
    if (busy || visualEdit || !currentZipFiles || accessoryOverlays.get(id)!==overlay) return;
    releaseOverlay(overlay);
    accessoryOverlays.delete(id);
    equippedIds=equippedIds.filter(item=>item!==id);
    renderEquipment(id);
    $('zipAccessory').focus();
    $('zipEquipmentStatus').textContent=accessoryLabel(accessoryById(id))+'を外しました。';
    refreshZipTraitStatus();
    paint();
  });
  overlayStatus(overlay,'重ね絵なし。分析装備は有効です。');
  return overlay;
}
function renderEquipment(preferred=$('zipAccessory').value) {
  const picker=$('zipAccessory');
  $('zipEquip').disabled=!currentZipFiles;
  const available=new Map([...accessoryCatalog,...manifestAccessories]);
  const empty=new Option('選択してください','');
  const options=[...available.values()].map(item=>new Option(accessoryLabel(item),item.id));
  picker.replaceChildren(empty,...options);
  picker.value=available.has(preferred)?preferred:'';
  const rows=equippedIds.map(id=>{
    if (!accessoryOverlays.has(id)) accessoryOverlays.set(id,createOverlayRow(id));
    const {row}=accessoryOverlays.get(id);
    row.querySelector('legend').textContent=accessoryLabel(available.get(id));
    row.querySelector('fieldset').disabled=!canAttachOverlays();
    row.querySelector('[data-action=unequip]').hidden=Boolean(visualEdit);
    return row;
  });
  const list=$('zipEquipped');
  if (list.children.length!==rows.length || rows.some((row,index)=>list.children[index]!==row))
    list.replaceChildren(...rows);
  $('zipOverlayHelp').hidden=!rows.length;
}
function accessoryById(id) {
  return accessoryCatalog.get(id)??manifestAccessories.get(id);
}
function clearZipEquipment() {
  for (const overlay of accessoryOverlays.values()) releaseOverlay(overlay);
  accessoryOverlays.clear();
  equippedIds=[];
  manifestAccessories.clear();
  renderEquipment('');
  $('zipEquipmentStatus').textContent='';
  paint();
}
async function loadAccessoryCatalog() {
  try {
    const response=await fetch(accessoryEndpoint,{cache:'no-store',credentials:'same-origin'});
    const data=await response.json();
    if(!response.ok||!Array.isArray(data.accessories))throw Error();
    for(const item of data.accessories)accessoryCatalog.set(item.id,item);
    renderEquipment();
  }catch{
    $('zipEquipmentStatus').textContent='このPCのアクセサリー一覧を読み込めませんでした。';
  }
}
$('zipEquip').addEventListener('click',()=>{
  if(busy||visualEdit||!currentZipFiles)return;
  const item=accessoryById($('zipAccessory').value);
  const feedback=$('zipEquipmentStatus');
  if(!item){
    feedback.textContent='装備するアクセサリーを選んでください。';
    $('zipAccessory').focus();
    return;
  }
  if(equippedIds.length>=MAX_EQUIPPED_ACCESSORIES){
    feedback.textContent='装備は最大3個です。入れ替えるには先に1個外してください。';
    return;
  }
  if(equippedIds.some(id=>accessoryById(id).method===item.method)){
    feedback.textContent='同じ分析方法のアクセサリーは1個だけ装備できます。';
    return;
  }
  equippedIds.push(item.id);
  renderEquipment('');
  feedback.textContent=accessoryLabel(item)+'を装備しました。';
});
$('zipAddAccessory').addEventListener('click',async()=>{
  if(busy||visualEdit||savingAccessory)return;
  const nameField=$('zipAccessoryName');
  const methodField=$('zipAccessoryMethod');
  const feedback=$('zipEquipmentStatus');
  if(!nameField.reportValidity()||!methodField.reportValidity())return;
  let definition;
  try {definition=normalizeAccessoryDefinition({name:nameField.value,method:methodField.value});}
  catch(error){
    nameField.setCustomValidity(error.message);
    nameField.reportValidity();
    return;
  }
  const create=$('zipAddAccessory');
  savingAccessory=create.disabled=nameField.disabled=methodField.disabled=true;
  refreshEditPicker();
  try {
    const response=await fetch(accessoryEndpoint,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(definition),cache:'no-store',credentials:'same-origin',
    });
    const item=await response.json();
    if(!response.ok)throw Error(item.error||'アクセサリーを追加できませんでした。');
    accessoryCatalog.set(item.id,item);
    renderEquipment(item.id);
    nameField.value='';
    methodField.value='';
    feedback.textContent=accessoryLabel(item)+'を一覧に追加しました。「装備する」でキャラに付けられます。';
  }catch(error){
    feedback.textContent=error.message;
  }finally{
    savingAccessory=create.disabled=nameField.disabled=methodField.disabled=false;
    refreshEditPicker();
  }
});
$('zipAccessoryName').addEventListener('input',event=>event.target.setCustomValidity(''));
renderEquipment();
void loadAccessoryCatalog();

function refreshZipTraitStatus() {
  const pending=[...accessoryOverlays.values()].some(overlay=>overlay.pending);
  $('saveVisualEdit').disabled=busy || !visualEdit || pending;
  const missing=zipLookFields.filter(id=>!$(id).value)
    .map(id=>({zipHairStyle:'髪型',zipExpression:'性格・表情'}[id]));
  $('registerZip').disabled=busy || !currentZipFiles || missing.length>0 || pending;
  if(!currentZipFiles)return;
  $('zipTraitsStatus').textContent=pending ? '重ね絵を確認しています。' : missing.length ?
    '未指定：'+missing.join('・')+'。ZIPの情報にない特徴は選択してください。' :
    '登録できます。髪型・色は補助分析、表情は資金使用率に反映します。';
}
function applyZipAppearance(files) {
  const traits=files.appearance ?? {};
  equippedIds=traits.accessories?.map((item,index)=>{
    if(typeof item==='string')return item;
    const id='manifest-'+index;
    manifestAccessories.set(id,{id,...item});
    return id;
  })??(builtinAccessories.has(traits.accessory)?[traits.accessory]:[]);
  renderEquipment('');
  for(const [field,id] of [
    ['hair_style','zipHairStyle'],
    ['expression','zipExpression'],['hair_color','zipHairColor'],
    ['clothing_color','zipClothingColor']]) {
    $(id).value=traits[field]??(field.endsWith('_color')?'#808080':'');
  }
  $('zipName').value=traits.name??'新しい相棒';
  const fromZip=['accessory','accessories','hair_style','expression','hair_color','clothing_color']
    .filter(key=>Object.hasOwn(traits,key));
  $('zipTraitsStatus').textContent=fromZip.length ?
    'ZIPのmanifest.jsonから取得：'+fromZip.join('・')+
    '。ない特徴は選択してください。' :
    'ZIPには登録済みの外見情報がありません。画像を見ながら選択してください。';
}
for(const id of [...zipLookFields,'zipHairColor','zipClothingColor']) {
  $(id).addEventListener('change',refreshZipTraitStatus);
}
// Users select ONE archive; registration is a separate explicit disk write.
async function importCharacterZip(file){
  if(!file || busy || visualEdit)return;
  const frames=Number($('zipFrames').value);
  // A failed replacement must never leave the previous character on screen.
  resetPack();
  currentZipFiles=null;
  clearZipEquipment();
  $('registerZip').disabled=true;
  $('zipGameLink').hidden=true;
  $('zipRegisterStatus').textContent='新しいZIPを確認しています。登録はまだしていません。';
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
    const next=inspect({...temp},frames);
    if(myEpoch!==epoch)return;
    displayLoaded(next,frames);
    for(const key of Object.keys(temp))delete temp[key];
    currentZipFiles=files;
    applyZipAppearance(files);
    refreshZipTraitStatus();
    $('zipRegisterStatus').textContent='読み込み成功。外見の特徴を確認して登録できます。';
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
$('zipFrames').addEventListener('change',endDrag);

async function encodeImage(file) {
  const bytes=new Uint8Array(await file.arrayBuffer());
  let text='';
  for(let offset=0;offset<bytes.length;offset+=32768) {
    text+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  }
  return {mime:file.type,base64:btoa(text)};
}
function savedImageBlob({mime,base64}) {
  const binary=atob(base64);
  const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
  return new Blob([bytes],{type:mime});
}
async function registeredAccessoryId(definition) {
  if(typeof definition==='string')return definition;
  const normalized=normalizeAccessoryDefinition(definition);
  const input=new TextEncoder().encode(accessoryIdentityInput(normalized));
  const hash=await crypto.subtle.digest('SHA-256',input);
  return 'accessory_'+Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function encodeVisual(registrationEquipment) {
  const mood=Object.hasOwn(pack.images,$('mood').value)?$('mood').value:'ready';
  const offsets=Object.fromEntries(Object.entries(layerOffsets).map(([layer,offset])=>
    [layer==='base'?'body':layer,{...offset}]));
  const overlays=[];
  for(const [index,id] of equippedIds.entries()) {
    const overlay=accessoryOverlays.get(id);
    if(!overlay?.file)continue;
    const {file,x,y,scale}=overlay;
    // Equipment is submitted in equippedIds order. The corresponding validated
    // definition yields the same final ID for manifest and catalog accessories.
    const savedId=registrationEquipment?await registeredAccessoryId(registrationEquipment[index]):id;
    overlays.push({id:savedId,image:await encodeImage(file),x,y,scale});
  }
  return {schema:1,mood,offsets,overlays};
}
async function composedPortrait() {
  if(!pack)throw Error('キャラ画像の読み込みが必要です。');
  const portrait=document.createElement('canvas');
  portrait.width=pack.width;
  portrait.height=pack.height;
  const target=portrait.getContext('2d',{alpha:true});
  target.imageSmoothingEnabled=true;
  target.imageSmoothingQuality='high';
  drawCharacter(target,0);
  const blob=await new Promise(resolve=>portrait.toBlob(resolve,'image/png'));
  if(!blob||blob.size>1024*1024)throw Error('合成プレビューが大きすぎます。');
  return new File([blob],'portrait.png',{type:'image/png'});
}

function refreshEditPicker() {
  const picker=$('editCharacter');
  picker.disabled=busy || loadingEditPicker || Boolean(visualEdit) || picker.options.length<=1;
  $('openVisualEdit').disabled=picker.disabled || savingAccessory || !picker.value;
}
async function loadEditPicker(selected=$('editCharacter').value) {
  loadingEditPicker=true;
  refreshEditPicker();
  try {
    const {characters}=await editRequest(characterEndpoint);
    const picker=$('editCharacter');
    picker.replaceChildren(new Option('選択してください',''),...characters.map(character=>
      new Option(character.name+'（'+character.id+'）',character.id)));
    picker.value=characters.some(item=>item.id===selected)?selected:'';
    $('editStatus').textContent=characters.length?'':'登録済みのZIPキャラはありません。';
  }catch(error){
    $('editStatus').textContent=error.message;
  }finally{
    loadingEditPicker=false;
    refreshEditPicker();
  }
}
async function editRequest(url,options={}) {
  const response=await fetch(url,{mode:'same-origin',cache:'no-store',credentials:'same-origin',...options});
  const data=await response.json();
  if(!response.ok)throw Object.assign(Error(data.error||'保存済みの画像を処理できませんでした。'),
    {status:response.status});
  return data;
}
function showVisualEdit(active) {
  $('visualEdit').hidden=!active;
  $('editChooser').hidden=active;
  $('registerParts').hidden=active;
  $('zipEquipmentPicker').hidden=active;
  $('zipAccessoryCreator').hidden=active;
  $(active?'editEquipmentMount':'zipEquipmentMount').append($('zipEquipment'));
}
function showSavedPortrait() {
  const {character,portrait}=visualEdit;
  const url=new URL(character.image_url,location.origin);
  url.searchParams.set('v',portrait.image_sha256);
  $('editSavedPortrait').src=url.href;
}
function showSavedSettings(character) {
  const {appearance,accessory_analysis:analysis,model}=character;
  const equipment=analysis?.equipped ??
    (builtinAccessories.has(analysis?.accessory)?[builtinAccessories.get(analysis.accessory)]:[]);
  for(const item of equipment)manifestAccessories.set(item.id,item);
  equippedIds=equipment.map(item=>item.id);
  renderEquipment('');
  $('zipEquipmentStatus').textContent=equipment.length?'保存済みの予測用装備です。':
    appearance?'装備なし（移動平均）':'予測用装備なし';
  $('editName').textContent=character.name;
  const w=model.plugin_weights;
  $('editModel').textContent='キャラID・AI ID '+character.id+' ／ モデル '+character.model_version+
    ' ／ 分析比率 流れ'+w.trend+'%・勢い'+w.momentum+'%・反転'+w.reversion+'%・変動'+w.volatility+
    '% ／ 資金使用率 '+Math.round(model.risk_fraction*100)+'%';
  if(appearance) {
    const label=(id,value)=>[...$(id).options].find(option=>option.value===value)?.text ?? value;
    $('editTraits').textContent='髪型 '+label('zipHairStyle',appearance.look.hair_style)+
      ' ／ 性格・基本表情 '+label('zipExpression',appearance.look.expression)+
      ' ／ 髪色 '+appearance.colors.hair_color+' ／ 服色 '+appearance.colors.clothing_color;
  }else $('editTraits').textContent='登録時に指定した予測設定を使用します。';
}
$('editCharacter').addEventListener('change',refreshEditPicker);
$('openVisualEdit').addEventListener('click',async()=>{
  if($('openVisualEdit').disabled)return;
  const id=$('editCharacter').value;
  const myEpoch=++epoch;
  const images={};
  const overlays=new Map();
  resetPack();
  currentZipFiles=null;
  clearZipEquipment();
  const controller=new AbortController();
  editLoad=controller;
  setBusy(true);
  $('editStatus').textContent='保存済みの素材を読み込んでいます…';
  try {
    const {character,sources,portrait,visual}=await editRequest(characterEndpoint+'/visual-edit/'+id,
      {signal:controller.signal});
    if(myEpoch!==epoch)return;
    for(const [part,source] of Object.entries(sources)) {
      images[part==='body'?'base':part]=await decodeFile(savedImageBlob(source),part);
      if(myEpoch!==epoch)return;
    }
    // Registration bakes exactly one frame at its source size. The portrait
    // width distinguishes a single frame even when the sheet is divisible by six.
    const frames=images.base.width/portrait.width;
    const next=inspect({...images},frames);
    if(next.height!==portrait.height)throw Error('元の画像と保存画像のコマ寸法が一致しません。');
    for(const {id,image,x,y,scale} of visual?.overlays??[]) {
      const file=savedImageBlob(image);
      const bitmap=await decodeFile(file,'保存済みの重ね絵');
      overlays.set(id,{file,bitmap,x,y,scale});
      if(myEpoch!==epoch)return;
    }
    visualEdit={character,portrait};
    $('mood').value=Object.hasOwn(next.images,visual?.mood)?visual.mood:'ready';
    $('legacyVisualWarning').hidden=Boolean(visual);
    showVisualEdit(true);
    showSavedSettings(character);
    for(const [id,saved] of overlays) {
      const overlay=accessoryOverlays.get(id);
      Object.assign(overlay,saved);
      for(const input of overlay.adjustments)input.value=overlay[input.dataset.overlay];
      overlayStatus(overlay,'保存済みの重ね絵を表示中です。');
      overlays.delete(id);
    }
    showSavedPortrait();
    displayLoaded(next,frames,visual?.offsets);
    for(const part of Object.keys(images))delete images[part];
    $('editStatus').textContent=visual?'保存済みの表情・位置・重ね絵を復元しました。':
      '元の素材を初期位置で読み込みました。確認して保存するまで、保存画像は保持されます。';
    status('見た目編集のプレビューを表示しています。');
  }catch(error){
    if(myEpoch===epoch)$('editStatus').textContent=error.message;
  }finally{
    release({images});
    for(const {bitmap} of overlays.values())bitmap.close();
    if(editLoad===controller)editLoad=null;
    if(myEpoch===epoch)setBusy(false);
  }
});
$('cancelVisualEdit').addEventListener('click',()=>{
  if(busy||!visualEdit)return;
  ++epoch;
  visualEdit=null;
  resetPack();
  clearZipEquipment();
  $('editSavedPortrait').removeAttribute('src');
  showVisualEdit(false);
  setBusy(false);
  $('editStatus').textContent='編集を終了しました。未保存の変更は破棄されました。';
  status('プレビューを解除しました。');
  $('openVisualEdit').focus();
});
const confirmVisualEdit=$('confirmVisualEdit');
$('saveVisualEdit').addEventListener('click',()=>{
  if($('saveVisualEdit').disabled)return;
  endDrag();
  const attached=[...accessoryOverlays.values()].filter(overlay=>overlay.bitmap).length;
  $('confirmOverlayCount').textContent=equippedIds.length?
    '重ね絵を保存する装備 '+attached+' / '+equippedIds.length+' 件':'予測用アクセサリーの装備はありません。';
  confirmVisualEdit.showModal();
});
$('abortPortraitSave').addEventListener('click',()=>confirmVisualEdit.close());
$('confirmPortraitSave').addEventListener('click',async()=>{
  confirmVisualEdit.close();
  if($('saveVisualEdit').disabled)return;
  const edit=visualEdit, myEpoch=epoch;
  setBusy(true);
  $('editStatus').textContent='保存画像を差し替えています…';
  try {
    const portrait=await encodeImage(await composedPortrait());
    if(myEpoch!==epoch)return;
    const visual=await encodeVisual();
    if(myEpoch!==epoch)return;
    const result=await editRequest(characterEndpoint+'/visual-edit/'+edit.character.id,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({expected_image_sha256:edit.portrait.image_sha256,portrait,visual}),
    });
    if(myEpoch!==epoch)return;
    edit.portrait.image_sha256=result.image_sha256;
    showSavedPortrait();
    $('legacyVisualWarning').hidden=true;
    $('editStatus').textContent='同じキャラIDで保存画像を更新しました。表情・位置・重ね絵も保存しました。';
  }catch(error){
    if(myEpoch===epoch)$('editStatus').textContent=error.message+(error.status===409?
      '。未保存の編集は表示中です。別の画面で更新された場合は、編集を開き直すと最新の画像を確認できます。':'');
  }finally{
    if(myEpoch===epoch)setBusy(false);
  }
});
void loadEditPicker();

$('registerZip').addEventListener('click',async()=>{
  if($('registerZip').disabled||busy||visualEdit||!currentZipFiles)return;
  const name=$('zipName').value.trim();
  if(!name||[...name].length>16) {
    $('zipRegisterStatus').textContent='キャラ名は1〜16文字にしてください。';
    $('zipName').focus();
    return;
  }
  const files=currentZipFiles;
  const chosenEpoch=epoch;
  const ids=[...equippedIds];
  const legacyAccessory=ids.length===1&&builtinAccessories.has(ids[0])?ids[0]:'none';
  const equipment=ids.length>0&&legacyAccessory==='none'?{
    accessories:ids.map(id=>{
      if(builtinAccessories.has(id))return id;
      const {name,method}=accessoryById(id);
      return {name,method};
    }),
  }:{};
  const look={accessory:legacyAccessory,hair_style:$('zipHairStyle').value,expression:$('zipExpression').value};
  const colors={hair_color:$('zipHairColor').value,clothing_color:$('zipClothingColor').value};
  setRegistering(true);
  $('zipRegisterStatus').textContent='外見と専用AI設定をこのPCに登録しています…';
  try {
    const images={};
    images.portrait=await encodeImage(await composedPortrait());
    if(chosenEpoch!==epoch)return;
    for(const [part,file] of Object.entries(files))images[part]=await encodeImage(file);
    if(chosenEpoch!==epoch)return;
    const visual=await encodeVisual(equipment.accessories);
    if(chosenEpoch!==epoch)return;
    const response=await fetch('/api/imported-characters/register',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name,look,colors,images,...equipment,visual}),
      cache:'no-store',credentials:'same-origin',
    });
    const record=await response.json();
    if(chosenEpoch!==epoch)return;
    if(!response.ok||!/^zip_[0-9a-f]{32}$/.test(record.id)||record.ai_id!==record.id||
       record.source!=='ZIP_LOCAL'||record.model_origin!=='appearance_features'||
       record.trained!==false||!/^appearance-v1_/.test(record.model_version)||
       !record.model?.plugin_weights||!Number.isFinite(record.model.risk_fraction))
      throw Error(record.error||'外見からのAI作成結果を確認できません。');
    currentZipFiles=null; // one explicit registration per ZIP selection
    renderEquipment('');
    $('zipGameLink').hidden=false;
    const w=record.model.plugin_weights;
    const analysis=record.accessory_analysis;
    const builtin=builtinAccessories.get(analysis?.accessory);
    const equipmentText=Array.isArray(analysis?.equipped) ?
      analysis.equipped.map(accessoryLabel).join('・') :
      builtin ? accessoryLabel(builtin) : '装備なし（移動平均）';
    $('zipRegisterStatus').textContent=name+'を登録しました。キャラID＝AI ID：'+
      record.id+' ／ 主な分析：'+equipmentText+
      ' ／ 補助分析：流れ'+w.trend+'%・勢い'+w.momentum+
      '%・反転'+w.reversion+'%・変動'+w.volatility+
      '% ／ 資金使用率'+Math.round(record.model.risk_fraction*100)+
      '%。外見の特徴で決まる新規モデルです（未学習・実株価未対応）。';
    status('ZIPの外見と予測AI設定が同じIDで登録されました。表情・位置・重ね絵も保存しました。');
    void loadEditPicker(record.id);
  }catch(error){
    if(chosenEpoch===epoch)$('zipRegisterStatus').textContent='登録に失敗しました：'+error.message;
  }finally{
    if(chosenEpoch===epoch)setRegistering(false);
  }
});
$('loadOwn').addEventListener('click',()=>loadPack(false));
$('loadSample').addEventListener('click',()=>loadPack(true));
$('clear').addEventListener('click',()=>{
  if(registering||visualEdit)return;
  if(editLoad)$('editStatus').textContent='読み込みを中止しました。';
  ++epoch;
  setBusy(false);
  resetPack();
  currentZipFiles=null;
  clearZipEquipment();
  $('registerZip').disabled=true;
  for (const [,input] of [...keys,...generatedKeys]) $(input).value='';
  $('zipFile').value='';
  status('プレビューを解除しました。画像データは保存していません。');
});
$('pause').addEventListener('click',()=>{
  if (!pack || registering) return;
  endDrag();
  paused=!paused;
  $('pause').setAttribute('aria-pressed',String(paused));
  $('pause').textContent=paused?'再生する':'停止する';
  $('stage').dataset.paused=String(paused);
  startClock();
});
$('mood').addEventListener('change',paint);
$('fps').addEventListener('change',startClock);
layerPicker.addEventListener('change',()=>{
  endDrag();
  refreshPartControls();
});
$('resetLayerPosition').addEventListener('click',()=>{
  if ($('resetLayerPosition').disabled) return;
  endDrag();
  const offset=layerOffsets[layerPicker.value];
  offset.x=offset.y=0;
  syncOffsetInputs();
  paint();
});
for (const axis of offsetAxes) {
  for (const input of [faceInputs[axis],layerInputs[axis]]) {
    input.addEventListener('input',()=>{
      if (input.disabled) return;
      endDrag();
      const layer=input===faceInputs[axis]?'face':layerPicker.value;
      layerOffsets[layer][axis]=overlayValue(input.valueAsNumber,offsetBounds(layer));
      syncOffsetInputs(input);
      paint();
    });
    input.addEventListener('change',()=>syncOffsetInputs());
  }
}
refreshPartControls();
$('frames').addEventListener('change',()=>{
  if (registering || visualEdit) return;
  if (pack || busy) {
    ++epoch;currentZipFiles=null;setBusy(false);resetPack();
    clearZipEquipment();
    $('registerZip').disabled=true;
    status('コマ数が変わりました。画像をもう一度読み込んでください。');
  }
});
for (const [,input] of keys) $(input).addEventListener('change',()=>{
  if (pack) status('新しい画像を選びました。「選んだPNGで試す」で反映されます。');
});
function restartPreview() {
  endDrag();
  startClock();
}
document.addEventListener('visibilitychange',restartPreview);
reduced.addEventListener('change',restartPreview);
window.addEventListener('pagehide',()=>{
  ++epoch;currentZipFiles=null;visualEdit=null;resetPack();clearZipEquipment();
  showVisualEdit(false);setRegistering(false);
});
