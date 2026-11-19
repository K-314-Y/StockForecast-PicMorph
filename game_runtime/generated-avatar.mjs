/** Only the registered visual overlay is managed here; the underlying game stays live. */
const STATE='/api/active-character';
const CATALOG='/api/character-demos';
const PARTS=['body','ready','happy','cautious'];
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

export function mountGeneratedAvatar() {
  const element=id=>document.getElementById(id);
  const scene=element('scene');
  const sprite=element('generatedAvatar');
  const select=element('generatedAvatarSelect');
  const use=element('useGeneratedAvatar');
  const reset=element('resetGeneratedAvatar');
  const pause=element('generatedAvatarPause');
  const caption=element('generatedAvatarCaption');
  const status=message=>{element('generatedAvatarStatus').textContent=message;};
  const warning=message=>{element('generatedAvatarWarning').textContent=message;};
  let catalog=new Map();
  let urls=[];
  let record;
  let work;
  let epoch=0;

  function controls() {
    const locked=!record || work?.phase==='refresh' || work?.phase==='save';
    select.disabled=locked || !catalog.size;
    use.disabled=locked || Boolean(work) || !catalog.has(select.value) ||
      (record.active_demo_id===select.value && !sprite.hidden);
    reset.disabled=locked || (record.active_demo_id===null && work?.phase!=='decode');
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

  function display(id,parts) {
    const old=urls;
    urls=[];
    if(parts) {
      for(const [part,blob] of parts) {
        const url=URL.createObjectURL(blob);
        urls.push(url);
        sprite.style.setProperty('--avatar-'+part,`url("${url}")`);
      }
      const name=catalog.get(id) || '登録キャラ';
      caption.textContent='外見：'+name+'（登録キャラ）';
      sprite.setAttribute('aria-label',caption.textContent);
      scene.dataset.generatedAvatar='true';
    } else {
      for(const part of PARTS) sprite.style.removeProperty('--avatar-'+part);
      delete scene.dataset.generatedAvatar;
      delete sprite.dataset.paused;
      pause.setAttribute('aria-pressed','false');
    }
    sprite.hidden=caption.hidden=pause.hidden=!parts;
    for(const url of old) URL.revokeObjectURL(url);
  }

  function setCatalog(entries) {
    const next=new Map();
    for(const item of Array.isArray(entries) ? entries.slice(0,32) : []) {
      if(validId(item?.generated_id) && item.engine==='original-template' && typeof item.name==='string') {
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
      status(message || (record.active_demo_id ? '保存した登録キャラを表示しています。' : '元の外見を表示しています。'));
    } catch {
      if(request.epoch!==epoch) return;
      display(null);
      warning('登録キャラを表示できないため、元の外見を表示しています。');
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
    status(id===null ? '元の外見に戻しています…' : '登録キャラを読み込んでいます…');
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
      status(id===null ? '元の外見に戻しました。' : 'ゲームで使う外見をこのPCに保存しました。');
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
