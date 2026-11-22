/** Only the registered visual overlay is managed here; the underlying game stays live. */
import {mountPngDropRegistration} from './png-drop-registration.mjs';
const STATE='/api/active-character';
const CATALOG='/api/character-demos';
const PARTS=['body','ready','happy','cautious'];
const MOODS=PARTS.slice(1);
const WIDTH=192, HEIGHT=208, FRAMES=6, ATLAS_WIDTH=WIDTH*FRAMES;
const EQUIPMENT='/api/character-equipment/v1';
const ACCESSORIES='/api/independent-parts';
const MAX_ACCESSORY_BYTES=1024*1024;
const ANCHORS=['base','outfit','face','hair'];
const validId=id=>typeof id==='string' && id.length===35 && /^cp_[a-f0-9]{32}$/.test(id);
const sameOrigin={mode:'same-origin',cache:'no-store',redirect:'error'};

async function json(path,signal,body) {
  const response=await fetch(path,{...sameOrigin,signal,...(body===undefined ? {} : {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  })});
  if(!response.ok) throw Object.assign(Error('Appearance request failed'),{status:response.status});
  return response.json();
}

function checkedRecord(record) {
  if(record?.schema!==1 || !Number.isSafeInteger(record.revision) || record.revision<0 ||
      !(record.active_demo_id===null || validId(record.active_demo_id)) ||
      typeof record.available!=='boolean') throw Error('Invalid active appearance');
  return record;
}

async function loadParts(id,signal) {
  if(!validId(id)) throw Error('Invalid registered character ID');
  const parts=new Map();
  // Sequential requests stay within the local gallery's validation limit.
  for(const part of PARTS) {
    const response=await fetch(`${CATALOG}/${id}/${part}.png`,{...sameOrigin,signal});
    if(!response.ok) throw Error('Appearance part unavailable');
    const blob=await response.blob();
    signal.throwIfAborted();
    if(blob.type!=='image/png' || !blob.size || blob.size>512*1024) throw Error('Invalid image');
    const bitmap=await createImageBitmap(blob);
    try {
      signal.throwIfAborted();
      if(bitmap.width!==1152 || bitmap.height!==208) throw Error('Invalid atlas dimensions');
    } finally {bitmap.close();}
    parts.set(part,blob);
  }
  return parts;
}

function checkedEquipment(record,id) {
  if(record?.schema!==1 || record.character_id!==id || !Number.isSafeInteger(record.revision) || record.revision<0 ||
     !Array.isArray(record.parts) || record.parts.length>8 || (!record.revision && record.parts.length)) {
    throw Error('Invalid equipment record');
  }
  const seen=new Set();
  for(const entry of record.parts) {
    if(typeof entry?.part_id!=='string' || entry.part_id.length!==35 || !/^pt_[0-9a-f]{32}$/.test(entry.part_id) ||
       seen.has(entry.part_id) || !ANCHORS.includes(entry.layer_anchor) || typeof entry.visible!=='boolean' ||
       ![entry.x,entry.y].every(value=>Number.isInteger(value) && Math.abs(value)<=24) ||
       typeof entry.image_sha256!=='string' || entry.image_sha256.length!==64 || !/^[0-9a-f]{64}$/.test(entry.image_sha256)) {
      throw Error('Invalid equipment entry');
    }
    seen.add(entry.part_id);
  }
  return record.parts;
}

async function boundedGet(path,mime,limit,signal,sha256) {
  const response=await fetch(path,{...sameOrigin,method:'GET',signal,
    ...(sha256?{headers:{'X-Creature-Part-Preview':'1'}}:{})});
  const size=response.headers.get('content-length')??'';
  const contentType=response.headers.get('content-type');
  if(!response.ok || (mime==='image/png'?contentType:contentType?.split(';')[0])!==mime ||
     !/^\d+$/.test(size) || Number(size)<=0 || Number(size)>limit || !response.body ||
     (sha256 && response.headers.get('x-creature-part-sha256')!==sha256)) {
    await response.body?.cancel();
    throw Error('Invalid equipment response');
  }
  const bytes=new Uint8Array(Number(size));
  const reader=response.body.getReader();
  let offset=0;
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done)break;
      if(offset+value.length>bytes.length)throw Error('Oversized equipment response');
      bytes.set(value,offset);
      offset+=value.length;
    }
    if(offset!==bytes.length)throw Error('Incomplete equipment response');
    signal.throwIfAborted();
    return bytes;
  } finally {await reader.cancel().catch(()=>{});}
}

async function accessoryBlob(entry,signal) {
  const bytes=await boundedGet(`${ACCESSORIES}/${entry.part_id}/part.png`,'image/png',
    MAX_ACCESSORY_BYTES,signal,entry.image_sha256);
  const header=new DataView(bytes.buffer);
  if(bytes.length<33 || header.getUint32(0)!==0x89504e47 || header.getUint32(4)!==0x0d0a1a0a ||
     header.getUint32(8)!==13 || header.getUint32(12)!==0x49484452 ||
     header.getUint32(16)!==ATLAS_WIDTH || header.getUint32(20)!==HEIGHT || bytes[24]!==8 || bytes[25]!==6) {
    throw Error('Invalid accessory PNG');
  }
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const hash=Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
  if(hash!==entry.image_sha256)throw Error('Accessory PNG digest mismatch');
  signal.throwIfAborted();
  return new Blob([bytes],{type:'image/png'});
}

function checkAccessoryAlpha(ctx,bitmap) {
  let visible=false;
  for(let frame=0;frame<FRAMES;frame++) {
    ctx.clearRect(0,0,WIDTH,HEIGHT);
    ctx.drawImage(bitmap,frame*WIDTH,0,WIDTH,HEIGHT,0,0,WIDTH,HEIGHT);
    const rgba=ctx.getImageData(0,0,WIDTH,HEIGHT).data;
    let transparent=false;
    for(let i=3;i<rgba.length;i+=4) {
      transparent ||= rgba[i]===0;
      visible ||= rgba[i]>0;
      if(transparent && visible)break;
    }
    if(!transparent)throw Error('Accessory frame has no transparent background');
  }
  if(!visible)throw Error('Empty accessory atlas');
}

export function composeAvatarAtlas(ctx,body,face,equipment) {
  const layers=[{bitmap:body,x:0,y:0}];
  for(const anchor of ANCHORS) {
    if(anchor==='face')layers.push({bitmap:face,x:0,y:0});
    layers.push(...equipment.filter(entry=>entry.visible && entry.layer_anchor===anchor));
  }
  ctx.clearRect(0,0,ATLAS_WIDTH,HEIGHT);
  for(let frame=0;frame<FRAMES;frame++) {
    const left=frame*WIDTH;
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(left,0,WIDTH,HEIGHT);
      ctx.clip();
      for(const {bitmap,x,y} of layers) {
        ctx.drawImage(bitmap,left,0,WIDTH,HEIGHT,left+x,y,WIDTH,HEIGHT);
      }
    } finally {ctx.restore();}
  }
}

export async function loadAvatarEquipment(id,parts,signal) {
  if(!validId(id))throw Error('Invalid registered character ID');
  const bytes=await boundedGet(`${EQUIPMENT}/${id}`,'application/json',4096,signal);
  const record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  // The equipment GET has already validated all entries, including hidden ones.
  const entries=checkedEquipment(record,id).filter(entry=>entry.visible);
  if(!entries.length)return {strips:null,count:0};
  const open=[];
  const decode=async blob=>{
    const bitmap=await createImageBitmap(blob);
    open.push(bitmap);
    signal.throwIfAborted();
    if(bitmap.width!==ATLAS_WIDTH || bitmap.height!==HEIGHT)throw Error('Invalid atlas dimensions');
    return bitmap;
  };
  const sample=document.createElement('canvas');
  sample.width=WIDTH;sample.height=HEIGHT;
  const ctx=sample.getContext('2d',{willReadFrequently:true});
  const canvas=document.createElement('canvas');
  canvas.width=ATLAS_WIDTH;canvas.height=HEIGHT;
  const output=canvas.getContext('2d');
  try {
    const overlays=[];
    for(const entry of entries) {
      const bitmap=await decode(await accessoryBlob(entry,signal));
      checkAccessoryAlpha(ctx,bitmap);
      overlays.push({...entry,bitmap});
    }
    const body=await decode(parts.get('body'));
    const strips=new Map();
    for(const mood of MOODS) {
      const face=await decode(parts.get(mood));
      composeAvatarAtlas(output,body,face,overlays);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      signal.throwIfAborted();
      if(blob?.type!=='image/png' || !blob.size || blob.size>MAX_ACCESSORY_BYTES)throw Error('Unable to build composite atlas');
      strips.set(mood,blob);
    }
    return {strips,count:overlays.length};
  } finally {
    for(const bitmap of open)bitmap.close();
    sample.width=canvas.width=0;
  }
}

export function mountGeneratedAvatar() {
  const element=id=>document.getElementById(id);
  const scene=element('scene');
  const sprite=element('generatedAvatar');
  const select=element('generatedAvatarSelect');
  const use=element('useGeneratedAvatar');
  const reset=element('resetGeneratedAvatar');
  const pause=element('generatedAvatarPause');
  const caption=element('generatedAvatarCaption');
  const equipmentNote=element('generatedAvatarEquipment');
  const equipmentStatus=element('generatedAvatarEquipmentStatus');
  const currentName=element('avatarCurrentName');
  const currentDescription=element('avatarCurrentDescription');
  const ownCard=element('avatarOwnChoice');
  const demoCard=element('avatarDemoChoice');
  const selectionHint=element('avatarSelectionHint');
  const editNotice=element('avatarEditNotice');
  const registrationForm=element('registerCharacterForm');
  const registrationButton=element('registerCharacterButton');
  const registrationResult=element('registrationResult');
  const registrationCapability=element('registrationCapability');
  const status=message=>{element('generatedAvatarStatus').textContent=message;};
  const warning=message=>{element('generatedAvatarWarning').textContent=message;};
  let catalog=new Map();
  let urls=[];
  let record;
  let work;
  let equipmentWork;
  let epoch=0;
  let registrationSupported=false;
  let registrationBusy=false;

  function controls() {
    const locked=!record || registrationBusy || work?.phase==='refresh' || work?.phase==='save';
    registrationButton.disabled=!registrationSupported || registrationBusy || Boolean(work);
    const showingDemo=Boolean(record?.active_demo_id && !sprite.hidden);
    const pendingDemo=Boolean(catalog.has(select.value) && select.value!==record?.active_demo_id);
    select.disabled=locked || !catalog.size;
    use.disabled=locked || Boolean(work) || !catalog.has(select.value) ||
      (record.active_demo_id===select.value && !sprite.hidden);
    reset.disabled=locked || (record.active_demo_id===null && work?.phase!=='decode');
    ownCard.dataset.current=String(Boolean(record && !showingDemo));
    demoCard.dataset.current=String(showingDemo);
    editNotice.hidden=!showingDemo;
    currentName.textContent=!record ? '確認しています…' :
      showingDemo ? '登録キャラ：'+(catalog.get(record.active_demo_id)||'名前未取得') : '自分の外見';
    currentDescription.textContent=!record ? '保存状況を読み込んでいます。' :
      showingDemo ? '生成キャラを表示中。あなたのイラストや色の設定は残っています。' :
      record.active_demo_id!==null ?
        '保存された登録キャラが見つからないため、今は自分の外見を表示中です。' :
        '保存済みイラストや、髪色・髪型を設定した2Dキャラの表示です。';
    use.textContent=showingDemo && select.value===record.active_demo_id ?
      'このキャラを表示中' : 'このキャラに切り替える';
    reset.textContent=record?.active_demo_id===null ? '自分の外見を表示中' : '自分の外見を表示';
    selectionHint.textContent=!catalog.size ? '登録キャラがまだありません。PNGパーツ実験室から確認できます。' :
      showingDemo && select.value===record.active_demo_id ? 'このキャラを表示しています。' :
      pendingDemo ? 'まだ画面には反映していません。切り替えボタンを押すと保存されます。' :
      '選ぶだけでは変更されません。ボタンで適用します。';
  }

  function stopWork() {
    epoch++;
    if(work) {
      clearTimeout(work.timer);
      work.controller.abort();
      work=undefined;
    }
  }

  function begin(phase) {
    stopWork();
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),8000);
    work={phase,controller,timer,epoch};
    controls();
    return work;
  }

  function finish(request) {
    if(request.epoch!==epoch) return;
    stopWork();
    controls();
  }

  function replaceSources(parts) {
    const old=urls;
    const next=new Map();
    try {
      for(const [part,blob] of parts??[])next.set(part,URL.createObjectURL(blob));
    } catch(error) {
      for(const url of next.values())URL.revokeObjectURL(url);
      throw error;
    }
    for(const part of PARTS) {
      if(next.has(part))sprite.style.setProperty('--avatar-'+part,`url("${next.get(part)}")`);
      else sprite.style.removeProperty('--avatar-'+part);
    }
    urls=[...next.values()];
    for(const url of old)URL.revokeObjectURL(url);
  }

  async function showEquipment(id,parts) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),18000);
    const request={controller,timer};
    equipmentWork=request;
    equipmentStatus.textContent='装備を確認中…';
    equipmentNote.hidden=false;
    try {
      const {strips,count}=await loadAvatarEquipment(id,parts,controller.signal);
      controller.signal.throwIfAborted();
      if(equipmentWork!==request)return;
      if(strips)replaceSources(strips);
      equipmentStatus.textContent='装備: '+count+'個';
    } catch {
      if(equipmentWork!==request)return;
      equipmentStatus.textContent='装備を表示できません。Parts Labで保存済み装備を確認してください。';
    } finally {
      clearTimeout(timer);
      if(equipmentWork===request)equipmentWork=undefined;
    }
  }

  function display(id,parts) {
    if(equipmentWork) {
      clearTimeout(equipmentWork.timer);
      equipmentWork.controller.abort();
      equipmentWork=undefined;
    }
    equipmentStatus.textContent='';
    equipmentNote.hidden=true;
    replaceSources(parts);
    if(parts) {
      const name=catalog.get(id) || '登録キャラ';
      caption.textContent='外見：'+name+'（登録キャラ）';
      sprite.setAttribute('aria-label',caption.textContent);
      scene.dataset.generatedAvatar='true';
    } else {
      delete scene.dataset.generatedAvatar;
      delete sprite.dataset.paused;
      pause.setAttribute('aria-pressed','false');
    }
    sprite.hidden=caption.hidden=pause.hidden=!parts;
    if(parts)void showEquipment(id,parts);
  }

  function setCatalog(entries) {
    const next=new Map();
    for(const item of Array.isArray(entries) ? entries.slice(0,32) : []) {
      if(validId(item?.generated_id) && ['original-template','user-png'].includes(item.engine) &&
         typeof item.name==='string') {
        next.set(item.generated_id,item.name);
      }
    }
    catalog=next;
    select.replaceChildren(...(next.size ? [...next].map(([id,name])=>new Option(name,id)) :
      [new Option('利用できる登録キャラがありません','')]));
    if(catalog.has(record.active_demo_id)) select.value=record.active_demo_id;
  }

  async function refresh(message='') {
    const request=begin('refresh');
    const {signal}=request.controller;
    try {
      const [saved,entries]=await Promise.all([json(STATE,signal),json(CATALOG,signal).catch(()=>[])]);
      signal.throwIfAborted();
      if(request.epoch!==epoch) return;
      record=checkedRecord(saved);
      setCatalog(entries);
      warning('');
      if(record.active_demo_id===null) display(null);
      else {
        if(!record.available) throw Error('Selected demo is unavailable');
        const parts=await loadParts(record.active_demo_id,signal);
        if(request.epoch!==epoch) return;
        display(record.active_demo_id,parts);
      }
      status(message || (record.active_demo_id ? '保存した登録キャラを表示しています。' : '自分の外見を表示しています。'));
    } catch {
      if(request.epoch!==epoch) return;
      display(null);
      warning('登録キャラを表示できないため、自分の外見を表示しています。');
      status(message || (record?.active_demo_id ?
        '保存した登録キャラを読み込めません。外見の選択は保持されています。' :
        '登録キャラの外見設定を読み込めません。'));
    } finally {finish(request);}
  }

  async function save(id) {
    if(!record || (work && work.phase!=='decode') || (id!==null && !catalog.has(id))) return;
    if(id===null && record.active_demo_id===null) {
      stopWork();
      controls();
      status('読み込みを中止しました。');
      return;
    }
    const request=begin(id===null ? 'save' : 'decode');
    const {signal}=request.controller;
    status(id===null ? '自分の外見に切り替えています…' : '登録キャラを読み込んでいます…');
    try {
      const parts=id===null ? null : await loadParts(id,signal);
      if(request.epoch!==epoch) return;
      signal.throwIfAborted();
      request.phase='save';
      controls();
      const saved=await json(STATE,signal,{expected_revision:record.revision,active_demo_id:id});
      signal.throwIfAborted();
      if(request.epoch!==epoch) return;
      record=checkedRecord(saved);
      display(id,parts);
      warning('');
      status(id===null ? '自分の外見を表示しています。' : 'ゲームで使う外見をこのPCに保存しました。');
    } catch(error) {
      if(request.epoch!==epoch) return;
      if(error.status===409 || request.phase==='save' && signal.aborted) {
        await refresh(error.status===409 ?
          '別の画面で外見が更新されました。現在の設定を確認し、必要ならもう一度選んでください。' :
          '保存の結果を再取得しました。現在の外見を確認してください。');
      } else {
        status('登録キャラの外見を切り替えられませんでした。現在の外見を表示しています。');
      }
    } finally {finish(request);}
  }

  async function createAndRegister(event) {
    event.preventDefault();
    if(!registrationSupported || registrationBusy || work) return;
    const fields=new FormData(registrationForm);
    const input={
      name:String(fields.get('name')??'').trim(),
      hair_color:String(fields.get('hair_color')??''),
      clothing_color:String(fields.get('clothing_color')??''),
      accessory:String(fields.get('accessory')??'none'),
    };
    if(!input.name || [...input.name].length>16) {
      registrationResult.textContent='名前を1～16文字で入力してください。';
      return;
    }
    registrationBusy=true;
    controls();
    registrationButton.textContent='キャラを生成・登録中…';
    registrationResult.textContent='6コマの画像と3種類の表情を作って登録しています。';
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),38000);
    try {
      const created=await json(CATALOG+'/create',controller.signal,input);
      if(!validId(created?.generated_id) || created?.registered!==true ||
         created.engine!=='original-template') throw Error('Invalid registration');
      // Re-fetch verified entries; do not trust a client-provided ID alone.
      await refresh();
      if(!catalog.has(created.generated_id)) throw Error('Registration not available');
      select.value=created.generated_id;
      registrationResult.textContent='「'+created.name+'」を登録しました。次は下の「このキャラに切り替える」を押すとゲームに表示されます。';
      status('新しいキャラを登録しました。ゲームの表示はまだ変更していません。');
    } catch(error) {
      registrationResult.textContent=error?.name==='AbortError' ?
        '登録の確認が途中で止まりました。画面を再読込して一覧を確認してください。' :
        error?.status===429 ? '別のキャラを生成中です。しばらくしてから再実行してください。' :
        '登録できませんでした。Linuxのゲームサーバーと保存容量を確認してください。';
    } finally {
      clearTimeout(timer);
      registrationBusy=false;
      registrationButton.textContent='キャラを生成して登録';
      controls();
    }
  }

  registrationForm.addEventListener('submit',event=>void createAndRegister(event));
  void json(CATALOG+'/create').then(capability=>{
    registrationSupported=capability?.available===true;
    registrationCapability.textContent=registrationSupported ?
      'ここから新しいキャラを作成・登録できます。登録だけでは現在の表示は変わりません。' :
      'Windowsは画面確認用です。新しいキャラの作成・登録はLinuxのゲーム画面で行ってください。';
  }).catch(()=>{
    registrationSupported=false;
    registrationCapability.textContent='登録機能の利用状況を確認できません。';
  }).finally(controls);

  mountPngDropRegistration({
    onRegistered:async created=>{
      await refresh();
      if(catalog.has(created.generated_id)) {
        select.value=created.generated_id;
        controls();
        status('PNGキャラを登録しました。ゲームで使うには「このキャラに切り替える」を押してください。');
      }
    },
  });

  select.addEventListener('change',()=>{
    if(work?.phase==='decode') {
      stopWork();
      status('選び直したキャラを使うにはボタンを押してください。');
    }
    controls();
  });
  use.addEventListener('click',()=>void save(select.value));
  reset.addEventListener('click',()=>void save(null));
  pause.addEventListener('click',()=>{
    const paused=sprite.toggleAttribute('data-paused');
    pause.setAttribute('aria-pressed',String(paused));
  });
  window.addEventListener('pagehide',()=>{
    stopWork();
    display(null);
  });
  window.addEventListener('pageshow',event=>{if(event.persisted) void refresh();});
  void refresh();
}
