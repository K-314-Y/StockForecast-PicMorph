/**
 * Manual rectangular image extraction. A new transparent layer is produced
 * without modifying the original base image or the Node-saved artwork.
 * This is not automatic person/hair segmentation: opaque backgrounds INSIDE
 * the chosen rectangle are intentionally retained.
 */
export const MAX_CROP_PIXELS = 4 * 1024 * 1024;
export const MAX_CROP_SIDE = 4096;
export const MAX_CROP_BYTES = 450 * 1024;

export function rectangleFromCorners(ax, ay, bx, by, imageWidth, imageHeight) {
  const width = Number(imageWidth), height = Number(imageHeight);
  if (![ax,ay,bx,by,width,height].every(Number.isFinite) ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1) throw Error('画像の大きさが不正です');
  const clamp = (v,max) => Math.max(0,Math.min(max,Math.round(v)));
  const x1=clamp(ax,width), x2=clamp(bx,width);
  const y1=clamp(ay,height), y2=clamp(by,height);
  return {x:Math.min(x1,x2),y:Math.min(y1,y2),
    width:Math.abs(x2-x1),height:Math.abs(y2-y1)};
}

export function validatedCropRectangle(rect,imageWidth,imageHeight) {
  const width=Number(imageWidth),height=Number(imageHeight);
  const {x,y,width:w,height:h} = rect ?? {};
  if (![x,y,w,h,width,height].every(Number.isSafeInteger) ||
      width < 1 || height < 1 || x < 0 || y < 0 ||
      w < 1 || h < 1 || x + w > width || y + h > height) {
    throw Error('選択範囲が画像の外、または空になっています');
  }
  return {x,y,width:w,height:h};
}

export function imagePointFromPointer(clientX,clientY,bounds,imageWidth,imageHeight) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0)
    throw Error('編集画像が表示されていません');
  // Use CSS bounds, not devicePixelRatio or canvas backing pixel dimensions.
  // This remains correct after responsive scaling and browser zoom.
  const x=(clientX-bounds.left)/bounds.width*imageWidth;
  const y=(clientY-bounds.top)/bounds.height*imageHeight;
  return {x:Math.max(0,Math.min(imageWidth,Math.round(x))),
    y:Math.max(0,Math.min(imageHeight,Math.round(y)))};
}

export function initCropEditor({
  documentRef=typeof document==='undefined'?null:document,
  fetchRef=typeof fetch==='undefined'?null:fetch,
  createBitmap=typeof createImageBitmap==='undefined'?null:createImageBitmap,
}={}) {
  if (!documentRef || !fetchRef || !createBitmap) return null;
  const $ = id => documentRef.getElementById(id);
  if (!$('cropCanvas') || !$('cropLoad')) return null;
  const canvas=$('cropCanvas'), ctx=canvas.getContext('2d');
  if (!ctx) return null;
  const ids=['cropX','cropY','cropWidth','cropHeight'];
  const slots=['hair','face','outfit'];
  let bitmap=null, source=null, rect=null, anchor=null, busy=false, downloadUrl=null;
  const status=(message)=>{$('cropStatus').textContent=message;};
  const values=()=>({x:Number($('cropX').value),y:Number($('cropY').value),
    width:Number($('cropWidth').value),height:Number($('cropHeight').value)});
  const cleanDownload=()=>{
    if(downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl=null;
    $('cropDownload').hidden=true;
    $('cropDownload').removeAttribute('href');
  };
  const dispose=()=>{
    if(bitmap?.close) bitmap.close();
    bitmap=null;source=null;rect=null;anchor=null;
    canvas.hidden=true;
    cleanDownload();
  };
  const updateControls=()=>{
    let valid=false;
    if(bitmap && rect && ids.every(id=>$(id).value.trim()!=='')){
      try { validatedCropRectangle(rect,bitmap.width,bitmap.height); valid=true; }
      catch { valid=false; }
    }
    $('cropCreate').disabled=busy || !valid;
    $('cropReset').disabled=busy || !bitmap;
    $('cropLoad').disabled=busy;
    for(const id of [...ids,'cropTarget']) $(id).disabled=busy || !bitmap;
  };
  const redraw=()=>{
    if(!bitmap)return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    if (!rect || rect.width===0 || rect.height===0) return;
    const scaleX=canvas.width/bitmap.width,scaleY=canvas.height/bitmap.height;
    const x=rect.x*scaleX,y=rect.y*scaleY,w=rect.width*scaleX,h=rect.height*scaleY;
    ctx.save();
    ctx.fillStyle='rgba(11,22,40,0.25)';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    // The selected pixels themselves remain bright, exactly as they will export.
    ctx.drawImage(bitmap,rect.x,rect.y,rect.width,rect.height,x,y,w,h);
    ctx.strokeStyle='#ffe39b';ctx.lineWidth=2;
    ctx.setLineDash([7,3]);
    ctx.strokeRect(x,y,w,h);
    ctx.restore();
  };
  const setRect=next=>{
    rect=next;
    $('cropX').value=next.x;
    $('cropY').value=next.y;
    $('cropWidth').value=next.width;
    $('cropHeight').value=next.height;
    redraw();updateControls();
  };
  const resetRect=()=>{
    if(!bitmap)return;
    setRect({x:0,y:0,width:0,height:0});
    status('左上から右下へドラッグするか、X/Y/幅/高さを数字で指定してください。');
  };
  const currentSource=()=>{
    // The artwork preview deliberately clears file inputs to avoid accidental
    // re-uploads, so retrieve the displayed same-origin Blob URL instead.
    const url=$('artworkBase')?.src || '';
    if(url.startsWith('blob:'))return {type:'preview',url};
    return {type:'saved'};
  };
  $('cropLoad').addEventListener('click',async()=>{
    if(busy)return;
    busy=true;updateControls();dispose();
    try {
      const chosen=currentSource();
      let blob;
      let decoded;
      let revision=null;
      if(chosen.type==='preview') {
        // The browser already loaded the uploaded local Blob in an <img>.
        // createImageBitmap(img) respects the restrictive connect-src CSP;
        // fetching blob: URLs directly would require weakening that policy.
        const displayed=$('artworkBase');
        if(!displayed.complete || displayed.naturalWidth===0)await displayed.decode();
        decoded=await createBitmap(displayed);
      }else {
        const metaResponse=await fetchRef('/api/artwork',{cache:'no-store'});
        if(!metaResponse.ok)throw Error('保存済みイラストの情報を取得できません');
        const metadata=await metaResponse.json();
        if(!metadata.slots?.base?.exists)throw Error('先に完成イラストを選択または保存してください');
        revision=metadata.revision;
        const result=await fetchRef('/api/artwork/image/base',{cache:'no-store'});
        if(!result.ok)throw Error('保存済みの完成イラストを取得できません');
        blob=await result.blob();
      }
      if(blob){
        if(!['image/png','image/jpeg','image/webp'].includes(blob.type) || blob.size > MAX_CROP_BYTES)
          throw Error('元画像はPNG/JPEG/WebPで450KB以下にしてください');
        decoded=await createBitmap(blob);
      }
      if(decoded.width>MAX_CROP_SIDE || decoded.height>MAX_CROP_SIDE ||
         decoded.width*decoded.height>MAX_CROP_PIXELS ||
         decoded.width<1 || decoded.height<1) {
        decoded.close?.();
        throw Error('元画像が大きすぎます（縦横4096px以下・合計約400万画素以下）。別の画像を用意してください');
      }
      bitmap=decoded;
      source={...chosen,revision};
      const scale=Math.min(1,480/decoded.width,480/decoded.height);
      canvas.width=Math.max(1,Math.round(decoded.width*scale));
      canvas.height=Math.max(1,Math.round(decoded.height*scale));
      canvas.hidden=false;
      $('cropCanvasSize').textContent='元画像：'+decoded.width+' × '+decoded.height+'px。指定値は元画像のピクセルです。';
      for(const [key,max] of [['cropX',decoded.width],['cropWidth',decoded.width],
        ['cropY',decoded.height],['cropHeight',decoded.height]])$(key).max=String(max);
      resetRect();
    }catch(error) {
      dispose();
      status('画像を編集台へ読み込めません: '+error.message);
    }finally{busy=false;updateControls();}
  });
  for(const id of ids) $(id).addEventListener('input',()=>{
    if(!bitmap)return;
    const v=values();
    rect=v;
    if (!ids.every(key => Number.isSafeInteger(Number($(key).value)) && $(key).value.trim()!=='')) {
      $('cropCreate').disabled=true;
      status('数値を整数で指定してください。');
      return;
    }
    try {
      validatedCropRectangle(v,bitmap.width,bitmap.height);
      status('範囲を確認して「未保存レイヤーを作る」を押してください。');
    }catch(error){status(error.message);}
    redraw();updateControls();
  });
  const point=event=>imagePointFromPointer(
    event.clientX,event.clientY,canvas.getBoundingClientRect(),bitmap.width,bitmap.height);
  canvas.addEventListener('pointerdown',event=>{
    if(!bitmap || busy || (event.pointerType==='mouse'&&event.button!==0))return;
    event.preventDefault();
    cleanDownload();
    anchor=point(event);
    setRect(rectangleFromCorners(anchor.x,anchor.y,anchor.x,anchor.y,bitmap.width,bitmap.height));
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointermove',event=>{
    if(!anchor || !bitmap || busy)return;
    setRect(rectangleFromCorners(anchor.x,anchor.y,point(event).x,point(event).y,bitmap.width,bitmap.height));
  });
  canvas.addEventListener('pointerup',event=>{
    if(!anchor || !bitmap)return;
    const end=point(event);
    setRect(rectangleFromCorners(anchor.x,anchor.y,end.x,end.y,bitmap.width,bitmap.height));
    anchor=null;
    if(rect.width>0&&rect.height>0)status('範囲を選択しました。必要なら数値で微調整できます。');
    canvas.releasePointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointercancel',()=>{anchor=null;resetRect();});
  $('cropReset').addEventListener('click',()=>{if(!busy)resetRect();});
  $('cropCreate').addEventListener('click',async()=>{
    if(!bitmap || !source || busy)return;
    let selected;
    try{selected=validatedCropRectangle(values(),bitmap.width,bitmap.height);}
    catch(error){status(error.message);return;}
    const slot=$('cropTarget').value;
    if(!slots.includes(slot)){status('保存先を選んでください。');return;}
    // A file chosen after opening the editor (or a new saved revision) invalidates
    // the previous selection. Never silently crop the wrong source.
    if(source.type==='preview' && $('artworkBase')?.src!==source.url){
      status('完成イラストが変更されました。編集台へ読み込み直してください。');return;
    }
    busy=true;updateControls();
    try {
      if(source.type==='saved'){
        const response=await fetchRef('/api/artwork',{cache:'no-store'});
        const info=await response.json();
        if(!response.ok || info.revision!==source.revision)
          throw Error('保存済み画像の状態が変わりました。編集台へ読み込み直してください');
      }
      // Same-size transparent canvas preserves the alignment with the base.
      const result=documentRef.createElement('canvas');
      result.width=bitmap.width;result.height=bitmap.height;
      const output=result.getContext('2d',{willReadFrequently:false});
      if(!output)throw Error('Canvasが使用できません');
      output.clearRect(0,0,result.width,result.height);
      output.drawImage(bitmap,selected.x,selected.y,selected.width,selected.height,
        selected.x,selected.y,selected.width,selected.height);
      const blob=await new Promise((resolve,reject)=>{
        result.toBlob(value=>value?resolve(value):reject(Error('PNGを書き出せません')),'image/png');
      });
      if(blob.size>MAX_CROP_BYTES)
        throw Error('切り出したPNGが450KBを超えています。範囲を小さくしてください');
      cleanDownload();
      downloadUrl=URL.createObjectURL(blob);
      $('cropDownload').href=downloadUrl;
      $('cropDownload').download=slot+'-handmade-layer.png';
      $('cropDownload').hidden=false;
      if(typeof File==='undefined' || typeof DataTransfer==='undefined') {
        status('PNGを作成しました。ダウンロードして「'+slot+'」のファイル欄から選んでください。');
        return;
      }
      const file=new File([blob],slot+'-handmade-layer.png',{type:'image/png'});
      const data=new DataTransfer();
      data.items.add(file);
      const target=$('artworkFile'+slot[0].toUpperCase()+slot.slice(1));
      target.files=data.files;
      target.dispatchEvent(new Event('change',{bubbles:true}));
      status('選択した四角形の外側を透明にしたPNGを「'+
        ({hair:'髪',face:'顔',outfit:'服'})[slot]+'」の未保存レイヤーへ反映しました。元画像は変更していません。気に入ったら上のSAVEを押してください。'+
        (source.type==='preview' ? '完成イラストも別途SAVEしておくと、再読み込み後に組み合わせて表示できます。' : ''));
    }catch(error){status('切り出せません: '+error.message);}
    finally{busy=false;updateControls();}
  });
  if(typeof window!=='undefined')window.addEventListener('pagehide',()=>dispose());
  updateControls();
  return {dispose};
}
if(typeof document!=='undefined') initCropEditor();
