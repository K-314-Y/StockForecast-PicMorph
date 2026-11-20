/* User-supplied PNG composition. Preview is browser-only.
 * Files are saved locally only after explicit ZIP character registration. */
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
let pack = null;
let currentZipFiles = null;
const zipLookFields=['zipAccessory','zipHairStyle','zipExpression'];
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
  for(const id of ['zipName',...zipLookFields,'zipHairColor','zipClothingColor','mood','faceX','faceY'])$(id).disabled=value;
  $('registerZip').disabled = value || !currentZipFiles ||
    zipLookFields.some(id=>!$(id).value);
  // Allow cancelling a slow decode or delayed sample request.
  $('clear').disabled = !value && !pack;
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
  currentZipFiles = null;
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
  currentZipFiles=null;
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
function refreshZipTraitStatus() {
  const missing=zipLookFields.filter(id=>!$(id).value)
    .map(id=>({zipAccessory:'アクセサリー',zipHairStyle:'髪型',zipExpression:'性格・表情'}[id]));
  $('registerZip').disabled=busy || !currentZipFiles || missing.length>0;
  if(!currentZipFiles)return;
  $('zipTraitsStatus').textContent=missing.length ?
    '未指定：'+missing.join('・')+'。ZIPの情報にない特徴は選択してください。' :
    '特徴が揃いました。アクセサリーは分析方法そのものを切り替え、髪型・色は補助分析、表情は資金使用率に反映します。';
}
function applyZipAppearance(files) {
  const traits=files.appearance ?? {};
  for(const [field,id] of [
    ['accessory','zipAccessory'],['hair_style','zipHairStyle'],
    ['expression','zipExpression'],['hair_color','zipHairColor'],
    ['clothing_color','zipClothingColor']]) {
    $(id).value=traits[field]??(field.endsWith('_color')?'#808080':'');
  }
  $('zipName').value=traits.name??'新しい相棒';
  const fromZip=['accessory','hair_style','expression','hair_color','clothing_color']
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
  if(!file || busy)return;
  currentZipFiles=null;
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
    const next=inspect({...temp},6);
    if(myEpoch!==epoch)return;
    displayLoaded(next,6);
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

async function encodeImage(file) {
  const bytes=new Uint8Array(await file.arrayBuffer());
  let text='';
  for(let offset=0;offset<bytes.length;offset+=32768) {
    text+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  }
  return {mime:file.type,base64:btoa(text)};
}
async function composedPortrait() {
  if(!pack)throw Error('キャラ画像の読み込みが必要です。');
  const before=frame;
  frame=0;paint();
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  frame=before;paint();
  if(!blob||blob.size>1024*1024)throw Error('合成プレビューが大きすぎます。');
  return new File([blob],'portrait.png',{type:'image/png'});
}
$('registerZip').addEventListener('click',async()=>{
  if(busy||!currentZipFiles)return;
  const name=$('zipName').value.trim();
  if(!name||[...name].length>16) {
    $('zipRegisterStatus').textContent='キャラ名は1〜16文字にしてください。';
    $('zipName').focus();
    return;
  }
  const files=currentZipFiles;
  const chosenEpoch=epoch;
  setBusy(true);
  $('zipRegisterStatus').textContent='外見と専用AI設定をこのPCに登録しています…';
  try {
    const images={};
    for(const [part,file] of Object.entries(files))images[part]=await encodeImage(file);
    images.portrait=await encodeImage(await composedPortrait());
    if(chosenEpoch!==epoch)return;
    const response=await fetch('/api/imported-characters/register',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name,look:{
          accessory:$('zipAccessory').value,
          hair_style:$('zipHairStyle').value,
          expression:$('zipExpression').value,
        },colors:{
          hair_color:$('zipHairColor').value,
          clothing_color:$('zipClothingColor').value,
        },images}),
      cache:'no-store',credentials:'same-origin',
    });
    const record=await response.json();
    if(!response.ok||!/^zip_[0-9a-f]{32}$/.test(record.id)||record.ai_id!==record.id||
       record.source!=='ZIP_LOCAL'||record.model_origin!=='appearance_features'||
       record.trained!==false||!/^appearance-v1_/.test(record.model_version)||
       !record.model?.plugin_weights||!Number.isFinite(record.model.risk_fraction))
      throw Error(record.error||'外見からのAI作成結果を確認できません。');
    currentZipFiles=null; // one explicit registration per ZIP selection
    $('zipGameLink').hidden=false;
    const w=record.model.plugin_weights;
    $('zipRegisterStatus').textContent=name+'を登録しました。キャラID＝AI ID：'+
      record.id+' ／ 主な分析：'+({
        star:'ボリンジャーバンド（急な上抜け）',
        glasses:'RSI（売られすぎ）',
        ribbon:'MACD（勢いの変化）',
        none:'移動平均（価格の流れ）',
      }[record.accessory_analysis?.accessory]??'未設定')+
      ' ／ 補助分析：流れ'+w.trend+'%・勢い'+w.momentum+
      '%・反転'+w.reversion+'%・変動'+w.volatility+
      '% ／ 資金使用率'+Math.round(record.model.risk_fraction*100)+
      '%。外見の特徴で決まる新規モデルです（未学習・実株価未対応）。';
    status('ZIPの外見と予測AI設定が同じIDで登録されました。');
  }catch(error){
    $('zipRegisterStatus').textContent='登録に失敗しました：'+error.message;
  }finally{setBusy(false);}
});
$('loadOwn').addEventListener('click',()=>loadPack(false));
$('loadSample').addEventListener('click',()=>loadPack(true));
$('clear').addEventListener('click',()=>{
  ++epoch;
  setBusy(false);
  resetPack();
  currentZipFiles=null;
  $('registerZip').disabled=true;
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
    ++epoch;currentZipFiles=null;setBusy(false);resetPack();
    $('registerZip').disabled=true;
    status('コマ数が変わりました。画像をもう一度読み込んでください。');
  }
});
for (const [,input] of keys) $(input).addEventListener('change',()=>{
  if (pack) status('新しい画像を選びました。「選んだPNGで試す」で反映されます。');
});
document.addEventListener('visibilitychange',startClock);
reduced.addEventListener('change',startClock);
window.addEventListener('pagehide',()=>{
  ++epoch;currentZipFiles=null;resetPack();setBusy(false);
});
