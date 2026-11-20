/* Import existing user PNG/WebP parts: drag/drop -> inspect -> explicit local registration.
 * No image bytes leave this local game. Registered images remain on the Linux computer. */
const API='/api/character-demos/import';
const ROLES=['body','ready','happy','cautious'];
const OPTIONAL=['outfit','hair'];
const ALL=[...ROLES,...OPTIONAL];
const PREPARED=Object.freeze({
  body:'/assets/hatchpet-demo-parts-body.webp',
  ready:'/assets/hatchpet-demo-parts-face-ready.webp',
  happy:'/assets/hatchpet-demo-parts-face-happy.webp',
  cautious:'/assets/hatchpet-demo-parts-face-cautious.webp',
});
const MAX_SOURCE_BYTES=5*1024*1024;
const MAX_PNG_BYTES=512*1024;
const WIDTH=192,HEIGHT=208,FRAMES=6;

const $=id=>document.getElementById(id);
const error=text=>Error(text);
const partFromName=name=>{
  const match=/(?:^|[-_])(body|ready|happy|cautious|hair|outfit)(?=[-_\.]|$)/i.exec(name);
  return match?.[1].toLowerCase()||null;
};

async function readSources(files) {
  if(!files.length || files.length>6) throw error('体と表情のPNG4枚（髪と服は任意）、またはZIP1個を選んでください。');
  let found;
  if(files.length===1 && /\.zip$/i.test(files[0].name)) {
    const {extractCharacterZip}=await import('/parts-lab/zip-import.mjs');
    found=await extractCharacterZip(files[0]);
  } else {
    found={};
    for(const file of files) {
      const role=partFromName(file.name);
      if(!role || found[role]) throw error('ファイル名に body / ready / happy / cautious / hair / outfit のいずれかを含めてください。');
      found[role]=file;
    }
  }
  if(ROLES.some(role=>!found[role])) throw error('body・ready・happy・cautious の4枚を選んでください。');
  for(const role of ALL.filter(role=>found[role])) {
    const file=found[role];
    if(!file.size || file.size>MAX_SOURCE_BYTES || !['image/png','image/webp'].includes(file.type)) {
      throw error(role+'は5MB以下のPNGまたはWebPにしてください。');
    }
  }
  return found;
}

function layout(image) {
  const w=image.width,h=image.height;
  if(w>0 && h>0 && w%6===0 && w/h>=3 && w/6>=32 && w/6<=1024 && h<=1024) {
    return {kind:'strip',width:w/6,height:h};
  }
  if(w%3===0 && h%2===0 && w/3===h/2 && w/3>=64 && w/3<=1024) {
    return {kind:'grid',width:w/3,height:h/2};
  }
  if(w>=32 && h>=32 && w<=1024 && h<=1024) return {kind:'single',width:w,height:h};
  throw error('PNGは横6コマ、3列×2行、または静止画にしてください。');
}

function normalizedCanvas(image,geometry) {
  const canvas=document.createElement('canvas');
  canvas.width=WIDTH*FRAMES;canvas.height=HEIGHT;
  const ctx=canvas.getContext('2d',{alpha:true});
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  for(let i=0;i<FRAMES;i++){
    const x=geometry.kind==='strip' ? i*geometry.width :
      geometry.kind==='grid' ? (i%3)*geometry.width : 0;
    const y=geometry.kind==='grid' ? Math.floor(i/3)*geometry.height : 0;
    ctx.drawImage(image,x,y,geometry.width,geometry.height,i*WIDTH,0,WIDTH,HEIGHT);
  }
  return canvas;
}

async function pngBlob(canvas) {
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob || blob.type!=='image/png' || !blob.size || blob.size>MAX_PNG_BYTES) {
    throw error('画像が大きすぎます。パーツを小さくするか透過背景で保存してください（各512KBまで）。');
  }
  return blob;
}

async function base64(blob) {
  const bytes=new Uint8Array(await blob.arrayBuffer());
  let result='';
  for(let i=0;i<bytes.length;i+=8192){
    result+=String.fromCharCode(...bytes.subarray(i,i+8192));
  }
  return btoa(result);
}

async function prepare(files) {
  const sources=await readSources(files);
  const atlases={},canvases={};
  let expected;
  let expectedCell;
  let kind;
  for(const role of ALL.filter(role=>sources[role])){
    let image;
    try {
      image=await createImageBitmap(sources[role]);
      const info=layout(image);
      const geometry=[image.width,image.height,info.kind].join('x');
      // Body and expression sheets must match. Static hair and outfit parts
      // may be one aligned frame and will be repeated across all six frames.
      const repeatStaticOverlay=OPTIONAL.includes(role) && info.kind==='single' &&
        info.width===expectedCell?.width && info.height===expectedCell?.height;
      if(expected && geometry!==expected && !repeatStaticOverlay)
        throw error('体と顔は同じコマ配置にしてください。髪・服は同じコマ配置か、1コマ分の画像を使えます。');
      if(!expected){
        expected=geometry;expectedCell={width:info.width,height:info.height};kind=info.kind;
      }
      const canvas=normalizedCanvas(image,info);
      // Facial overlays must be transparent so the character remains visible.
      if(role!=='body'){
        const context=canvas.getContext('2d',{willReadFrequently:true});
        const alpha=context.getImageData(0,0,1,1).data[3];
        if(alpha>=250) throw error(role+'の顔画像は透明背景にしてください。');
      }
      canvases[role]=canvas;
    } catch(e) {
      if(e instanceof Error && /PNG|画像|4枚|キャンバス|顔/.test(e.message)) throw e;
      throw error(role+'の画像を読み込めませんでした。');
    } finally {image?.close();}
  }
  // The registered format has four PNG atlases. Flatten outfit into body and
  // hair over each expression, preserving the requested visible layer order.
  if(canvases.outfit)canvases.body.getContext('2d').drawImage(canvases.outfit,0,0);
  if(canvases.hair){
    for(const role of ['ready','happy','cautious']){
      canvases[role].getContext('2d').drawImage(canvases.hair,0,0);
    }
  }
  for(const role of ROLES)atlases[role]=await pngBlob(canvases[role]);
  return {atlases,kind,partCount:Object.keys(sources).length};
}

async function preview(atlases) {
  const canvas=$('pngDropPreview');
  const ctx=canvas.getContext('2d',{alpha:true});
  ctx.clearRect(0,0,WIDTH,HEIGHT);
  for(const role of ['body','ready']) {
    const bitmap=await createImageBitmap(atlases[role]);
    try {ctx.drawImage(bitmap,0,0,WIDTH,HEIGHT,0,0,WIDTH,HEIGHT);}
    finally {bitmap.close();}
  }
  canvas.hidden=false;
}

export function mountPngDropRegistration({onRegistered}) {
  const zone=$('pngDropZone');
  const chooser=$('pngDropFileInput');
  const preparedButton=$('pngUsePreparedParts');
  const chosenPartsButton=$('pngLoadChosenParts');
  const register=$('pngRegisterButton');
  const status=$('pngImportStatus');
  const summary=$('pngFileSummary');
  const name=$('pngCharacterName');
  const notice=$('pngImportCapability');
  const canvas=$('pngDropPreview');
  let selected=null;
  let busy=false;
  let available=false;
  let revision=0;
  const update=()=>{
    register.disabled=busy || !available || !selected || !name.value.trim();
    preparedButton.disabled=busy;
    chosenPartsButton.disabled=busy;
  };
  const message=text=>{status.textContent=text;};

  async function load(files) {
    if(busy)return;
    const current=++revision;
    busy=true;selected=null;canvas.hidden=true;
    update();
    message('画像を確認して、6コマに揃えています…');
    try {
      const result=await prepare(files);
      if(current!==revision)return;
      await preview(result.atlases);
      if(current!==revision)return;
      selected=result.atlases;
      summary.textContent=result.partCount+'種類の画像パーツを認識しました（'+
        (result.kind==='grid'?'3列×2行':result.kind==='strip'?'横6コマ':'静止画を6コマ化')+
        '）。プレビューを確認してから登録してください。';
      message('画像の確認が完了しました。まだ保存はしていません。');
    } catch(e) {
      if(current!==revision)return;
      summary.textContent='画像を選び直してください。';
      message(e.message || '画像を確認できませんでした。');
    } finally {
      if(current===revision){busy=false;update();}
    }
  }

  // Reuse the four prepared HatchPet layers without any file browsing.
  // Preview is browser-local and never automatically saves a new avatar.
  preparedButton.addEventListener('click',async()=>{
    if(busy)return;
    busy=true;update();
    message('用意済みの体と3種類の表情画像を読み込んでいます…');
    try {
      const files=[];
      for(const role of ROLES){
        const response=await fetch(PREPARED[role],{
          method:'GET',mode:'same-origin',redirect:'error',cache:'no-store',
        });
        if(!response.ok)throw error('用意済みの画像を読み込めませんでした。');
        const blob=await response.blob();
        if(blob.type!=='image/webp' || blob.size>MAX_SOURCE_BYTES || blob.size===0)
          throw error('用意済みパーツの形式を確認できません。');
        files.push(new File([blob],'hatchpet-'+role+'.webp',{type:blob.type}));
      }
      if(!name.value.trim())name.value='HatchPet パーツ';
      busy=false;
      await load(files);
    } catch(e){
      message(e.message||'用意済みパーツを読み込めませんでした。');
    } finally{busy=false;update();}
  });

  chosenPartsButton.addEventListener('click',()=>{
    if(busy)return;
    const files=[];
    for(const role of ALL){
      const input=$('pngRole'+role[0].toUpperCase()+role.slice(1));
      const file=input.files?.[0];
      if(file){
        const ext=file.type==='image/webp'?'webp':'png';
        files.push(new File([file],'character_'+role+'.'+ext,{type:file.type}));
      }
    }
    void load(files);
  });

  chooser.addEventListener('change',()=>{
    if(chooser.files?.length) void load([...chooser.files]);
    chooser.value='';
  });
  for(const event of ['dragenter','dragover']) {
    zone.addEventListener(event,e=>{
      if(!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files'))return;
      e.preventDefault();zone.dataset.dragging='true';
    });
  }
  zone.addEventListener('dragleave',()=>{zone.dataset.dragging='false';});
  zone.addEventListener('drop',e=>{
    if(!e.dataTransfer?.files.length)return;
    e.preventDefault();zone.dataset.dragging='false';
    void load([...e.dataTransfer.files]);
  });
  zone.addEventListener('keydown',e=>{
    if((e.key==='Enter' || e.key===' ') && e.target===zone) {
      e.preventDefault();chooser.click();
    }
  });
  name.addEventListener('input',update);

  register.addEventListener('click',async()=>{
    if(!available || busy || !selected)return;
    const label=name.value.trim();
    if(!label || [...label].length>16){message('登録名は1～16文字にしてください。');return;}
    busy=true;update();message('合成したPNGパーツをこのLinuxのゲームに登録しています…');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),20000);
    try {
      const parts={};
      for(const role of ROLES)parts[role]=await base64(selected[role]);
      const response=await fetch(API,{
        method:'POST',mode:'same-origin',cache:'no-store',redirect:'error',
        signal:controller.signal,headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:label,parts}),
      });
      if(!response.ok)throw error(response.status===422 ?
        '画像を登録できません。透明背景やサイズを確認してください。' :
        '登録できませんでした。Linuxの保存先と登録済み件数を確認してください。');
      const saved=await response.json();
      if(!/^cp_[0-9a-f]{32}$/.test(saved?.generated_id) || saved.engine!=='user-png')
        throw error('登録結果を確認できませんでした。');
      selected=null;
      await onRegistered(saved);
      message('「'+saved.name+'」を登録しました。下の「このキャラに切り替える」でゲームに表示できます。');
      summary.textContent='登録が完了しました。次のキャラはPNGをドロップして作れます。';
    } catch(e){
      message(e.name==='AbortError'?
        '登録の確認が終わりませんでした。再読込して登録一覧を確認してください。' :
        (e.message||'登録できませんでした。'));
    } finally {clearTimeout(timer);busy=false;update();}
  });

  void fetch(API,{mode:'same-origin',cache:'no-store',redirect:'error'})
    .then(async response=>{
      if(!response.ok)throw Error('unavailable');
      const info=await response.json();
      available=info.available===true;
      notice.textContent=available ?
        'PNGをここにドロップして登録できます。保存先はこのLinux内だけです。' :
        'Windowsは確認専用です。PNGの登録はLinuxのゲーム画面で行ってください。';
    }).catch(()=>{
      available=false;notice.textContent='PNG登録機能を確認できません。';
    }).finally(update);
}
