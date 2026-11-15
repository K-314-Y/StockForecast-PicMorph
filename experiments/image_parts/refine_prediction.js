'use strict';
(function () {
  const MAX_PIXELS = 2000000, MAX_UNDO_BYTES = 32 * 1024 * 1024;
  function binary(mask) {
    if (!(mask instanceof Uint8Array) || !mask.length || mask.length > MAX_PIXELS) throw Error('不正な二値配列');
    for (const v of mask) if (v !== 0 && v !== 1) throw Error('二値ではありません');
    return mask;
  }
  function rgba(bytes, n) {
    if (!(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray) || bytes.length !== n * 4) throw Error('不正なRGBA');
  }
  function binaryMask(bytes) {
    if (!bytes || !bytes.length || bytes.length % 4 || bytes.length / 4 > MAX_PIXELS) throw Error('不正なマスク寸法');
    rgba(bytes, bytes.length / 4);
    const out = new Uint8Array(bytes.length / 4);
    for (let i = 0; i < out.length; i++) {
      const p = i * 4, a = bytes[p + 3];
      if (a !== 0 && a !== 255 || a === 255 && (bytes[p] !== 255 || bytes[p + 1] !== 255 || bytes[p + 2] !== 255)) throw Error('白＋透明の二値マスクだけを読み込めます');
      out[i] = a === 255 ? 1 : 0;
    }
    return out;
  }
  function brushDisk(mask, w, h, x, y, radius, value) {
    if (!(mask instanceof Uint8Array) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || mask.length !== w * h || mask.length > MAX_PIXELS || ![x,y,radius].every(Number.isFinite) || radius < 2 || radius > 40 || ![0,1].includes(value)) throw Error('不正なブラシ');
    for (let yy = Math.max(0, Math.ceil(y-radius)); yy <= Math.min(h-1, Math.floor(y+radius)); yy++) {
      for (let xx = Math.max(0, Math.ceil(x-radius)); xx <= Math.min(w-1, Math.floor(x+radius)); xx++) {
        if ((xx-x)**2 + (yy-y)**2 <= radius**2) mask[yy*w+xx] = value;
      }
    }
    return mask;
  }
  function countDiff(raw, edited) {
    binary(raw); binary(edited);
    if (raw.length !== edited.length) throw Error('寸法不一致');
    let selected=0, added=0, removed=0;
    for (let i=0;i<raw.length;i++) { selected+=edited[i]; if (!raw[i] && edited[i]) added++; if (raw[i] && !edited[i]) removed++; }
    return {selected, added, removed};
  }
  function maskBytes(mask) {
    binary(mask); const out=new Uint8ClampedArray(mask.length*4);
    for(let i=0;i<mask.length;i++) if(mask[i]) out.fill(255,i*4,i*4+4);
    return out;
  }
  function cutoutBytes(source,mask) {
    binary(mask); rgba(source,mask.length); const out=new Uint8ClampedArray(source.length);
    for(let i=0;i<mask.length;i++) if(mask[i]) out.set(source.subarray(i*4,i*4+4),i*4);
    return out;
  }
  function pngInfo(buffer) {
    const b=new Uint8Array(buffer), v=new DataView(buffer);
    if(b.length<33 || ![137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n)) throw Error('PNG署名が不正です');
    let w=0,h=0,end=false;
    for(let p=8;p<b.length;) {
      if(p+12>b.length) throw Error('PNGが途中で切れています');
      const n=v.getUint32(p), type=String.fromCharCode(...b.subarray(p+4,p+8));
      if(n>b.length-p-12) throw Error('PNGチャンクが不正です');
      if(p===8) { if(type!=='IHDR'||n!==13) throw Error('IHDRが不正です'); w=v.getUint32(p+8); h=v.getUint32(p+12); }
      if(type==='acTL'||type==='fcTL'||type==='fdAT') throw Error('APNGは使えません');
      p+=n+12;
      if(type==='IEND') { if(n!==0||p!==b.length) throw Error('PNG終端が不正です'); end=true; break; }
    }
    if(!end||!w||!h||w>4096||h>4096||w*h>MAX_PIXELS) throw Error('PNG寸法または終端が不正です');
    return {w,h};
  }
  if(typeof module!=='undefined' && module.exports) module.exports={binary,binaryMask,brushDisk,countDiff,maskBytes,cutoutBytes,pngInfo};
  if(typeof document==='undefined') return;
  const $=id=>document.getElementById(id), canvas=$('preview'), ctx=canvas.getContext('2d');
  let source=null, raw=null, edited=null, history=[], dirty=false, locked=false, stroke=null, generation=0, editRevision=0, busy=false;
  function ready(){return $('rights').checked && source && edited && !busy;}
  function controls(){
    $('source').disabled=$('prediction').disabled=!$('rights').checked;
    $('tools').disabled=!ready(); $('save').disabled=!ready(); $('part').disabled=!ready()||locked;
    $('undo').disabled=!ready()||!history.length;
  }
  function render(){
    if(!source) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(source.bytes),source.w,source.h),0,0);
    if(edited){
      const overlay=ctx.createImageData(source.w,source.h);
      for(let i=0;i<edited.length;i++) if(edited[i]) { overlay.data[i*4]=255; overlay.data[i*4+2]=140; overlay.data[i*4+3]=100; }
      const layer=document.createElement('canvas'); layer.width=source.w;layer.height=source.h;layer.getContext('2d').putImageData(overlay,0,0);ctx.drawImage(layer,0,0);
      const d=countDiff(raw,edited); $('stats').textContent=`${source.w} × ${source.h}／選択 ${d.selected}画素／読込予測との差：追加 ${d.added}・削除 ${d.removed}（精度ではありません）`;
    } else $('stats').textContent='元画像読込済み。予測マスクを選択してください。';
    controls();
  }
  function snapshot(){history.push(edited.slice());while(history.length>12 || history.length*edited.byteLength>MAX_UNDO_BYTES)history.shift();locked=true;}
  function finish(){if(stroke){const id=stroke.id;stroke=null;if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);} controls();}
  async function load(file){
    if(!file || !/\.png$/i.test(file.name)||file.size>8*1024*1024||!file.size) throw Error('8 MiB以下の.pngファイルを選んでください');
    const info=pngInfo(await file.arrayBuffer()), url=URL.createObjectURL(file);
    try {
      const img=new Image();img.src=url;await img.decode();
      if(img.naturalWidth!==info.w||img.naturalHeight!==info.h) throw Error('復号寸法不一致');
      const c=document.createElement('canvas');c.width=info.w;c.height=info.h;
      const cx=c.getContext('2d');cx.drawImage(img,0,0);
      return {...info,bytes:cx.getImageData(0,0,info.w,info.h).data};
    } finally {URL.revokeObjectURL(url);}
  }
  async function replace(kind,input){
    const file=input.files[0];input.value='';if(!file||!$('rights').checked)return;
    finish(); const token=++generation;
    if(dirty&&!confirm('編集を破棄してファイルを置き換えますか？')) {busy=false;controls();return;}
    busy=true;controls();$('status').textContent='PNGを検証しています…';
    try {
      const loaded=await load(file);
      if(token!==generation||!$('rights').checked)return;
      if(kind==='source') {source=loaded;raw=null;edited=null;canvas.width=source.w;canvas.height=source.h;}
      else {
        if(!source)throw Error('元PNGを先に読み込んでください');
        if(loaded.w!==source.w||loaded.h!==source.h)throw Error('元PNGとマスクの寸法が違います');
        const candidate=binaryMask(loaded.bytes);raw=candidate.slice();edited=candidate.slice();
      }
      history=[];dirty=false;locked=false;
      $('status').textContent=edited?'修正済み予測として編集・保存できます。部位名を手動確認してください。':'元PNG読込済み。予測マスクを選んでください。';render();
    } catch(e){if(token===generation)$('status').textContent=e.message;}
    finally {if(token===generation){busy=false;controls();}}
  }
  $('source').addEventListener('change',()=>replace('source',$('source')));
  $('prediction').addEventListener('change',()=>replace('prediction',$('prediction')));
  $('rights').addEventListener('change',()=>{++generation;busy=false;finish();controls();$('status').textContent=$('rights').checked?'権利確認済み。選択した画像だけを処理します。':'権利確認取消：編集・保存は無効です。';});
  function point(e){const r=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(source.w-1,(e.clientX-r.left)*source.w/r.width)),y:Math.max(0,Math.min(source.h-1,(e.clientY-r.top)*source.h/r.height))};}
  function paint(p){
    const r=Math.max(2,Math.min(40,Number($('radius').value)||2)), value=Number($('mode').value), prev=stroke.last||p;
    const steps=Math.max(1,Math.ceil(Math.hypot(p.x-prev.x,p.y-prev.y)));
    for(let i=1;i<=steps;i++)brushDisk(edited,source.w,source.h,prev.x+(p.x-prev.x)*i/steps,prev.y+(p.y-prev.y)*i/steps,r,value);
    stroke.last=p;dirty=true;editRevision++;render();
  }
  canvas.addEventListener('pointerdown',e=>{if(!ready()||stroke||e.button!==0)return;e.preventDefault();snapshot();stroke={id:e.pointerId,last:null};canvas.setPointerCapture(e.pointerId);paint(point(e));});
  canvas.addEventListener('pointermove',e=>{if(ready()&&stroke&&stroke.id===e.pointerId){e.preventDefault();paint(point(e));}});
  canvas.addEventListener('pointerup',e=>{if(stroke&&stroke.id===e.pointerId){if(ready())paint(point(e));finish();}});
  canvas.addEventListener('pointercancel',finish);canvas.addEventListener('lostpointercapture',finish);
  $('undo').addEventListener('click',()=>{if(!ready()||!history.length)return;finish();edited=history.pop();dirty=true;editRevision++;render();});
  $('clear').addEventListener('click',()=>{if(!ready()||!confirm('修正済み予測を全消去しますか？'))return;finish();snapshot();edited.fill(0);dirty=true;editRevision++;render();});
  $('save').addEventListener('click',()=>{
    if(!ready())return;finish();const format=$('format').value,part=$('part').value;
    if(!['mask','cutout'].includes(format)||!['hair','face','outfit'].includes(part)||!confirm(`修正済み予測（${part}・${format}）を保存します。独立した正解ではありません。保存しますか？`))return;
    const token=generation,revision=editRevision,c=document.createElement('canvas');c.width=source.w;c.height=source.h;
    c.getContext('2d').putImageData(new ImageData(format==='mask'?maskBytes(edited):cutoutBytes(source.bytes,edited),source.w,source.h),0,0);
    const nonce=Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('');
    c.toBlob(blob=>{if(!blob||token!==generation||revision!==editRevision||!ready()||$('format').value!==format||$('part').value!==part)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`creature_prediction_refined_${format}_${part}_${nonce}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},'image/png');
  });
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  controls();
})();
