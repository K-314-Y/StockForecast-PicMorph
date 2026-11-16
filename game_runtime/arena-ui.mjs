/** Game's optional read-only fair comparison panel. Never asks for XP or writes models. */
const $ = id=>document.getElementById(id);
const SLOTS=['mine','owl','turtle'];
const SELECTS={mine:'arenaMine',owl:'arenaOwl',turtle:'arenaTurtle'};
const TRAINED=/^tv_[0-9a-f]{32}$/;
let busy=false;
let match=null;
let activeDay=0;
const actorViews=new Map();
const coins=value=>Number(value).toLocaleString('ja-JP',{maximumFractionDigits:2});
const signed=value=>(value>0?'+':'')+coins(value);
function status(message){$('arenaStatus').textContent=message;}
function controls(){
  $('arenaLoad').disabled=busy;
  $('arenaRun').disabled=busy;
  for(const id of Object.values(SELECTS))$(id).disabled=busy;
}
async function get(path,body) {
  const response=await fetch(path,body===undefined?undefined:{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  });
  let value;
  try {value=await response.json();}
  catch {throw Error('サーバーの応答を読み取れません');}
  if(!response.ok)throw Error(value.error||'比較の実行に失敗しました');
  return value;
}
function choices(){
  return Object.fromEntries(SLOTS.map(slot=>[slot,$(SELECTS[slot]).value]));
}
async function loadModels(){
  if(busy)return;
  busy=true;controls();status('学習済みモデルを読み込んでいます…');
  try{
    const data=await get('/api/trained/versions');
    if(!Array.isArray(data.versions))throw Error('学習版一覧の形式が不正です');
    const old=choices();
    for(const slot of SLOTS){
      const select=$(SELECTS[slot]);
      select.replaceChildren();
      const fallback=document.createElement('option');
      fallback.value=slot==='mine'?'self':'preset';
      fallback.textContent=slot==='mine'?'保存した相棒（なければ標準）':
        slot==='owl'?'フクロウ（既存）':'カメ（既存）';
      select.append(fallback);
      for(const v of data.versions){
        if(!TRAINED.test(v?.id)||!/^bp_[a-f0-9]{32}$/.test(v?.source_draft_id))continue;
        const option=document.createElement('option');
        option.value=v.id;
        const source=typeof v.source_name==='string'&&v.source_name?v.source_name:v.id.slice(0,11);
        option.textContent='練習版 '+source+' · '+v.id.slice(0,11);
        select.append(option);
      }
      select.value=[...select.children].some(option=>option.value===old[slot])?
        old[slot]:fallback.value;
    }
    status(data.versions.length?
      '練習版を読み込みました。3体それぞれに割り当てて比較できます。':
      'まだ練習版はありません。保存した相棒と既存2体で比較できます。');
  }catch(error){
    status('学習版を取得できません: '+error.message+'。既存の選択で比較できます。');
  }finally{busy=false;controls();}
}
function buildAvatar(fighter){
  const persona=fighter.persona;
  const root=document.createElement('div');
  root.className='arena-avatar';
  root.setAttribute('role','img');
  root.setAttribute('aria-label',fighter.name+'。'+persona.label+'を擬人化した2Dキャラクター');
  root.dataset.hair=persona.look.hair_style;
  root.dataset.expression=persona.look.expression;
  root.dataset.accessory=persona.look.accessory;
  root.dataset.mood='ready';
  root.setAttribute('style','--av-hair:'+persona.look.hair_color+
    ';--av-clothing:'+persona.look.clothing_color);
  const hair=document.createElement('div');hair.className='av-hair';
  const outfit=document.createElement('div');outfit.className='av-outfit';
  const face=document.createElement('div');face.className='av-face';
  for(const side of ['left','right']){
    const eye=document.createElement('span');eye.className='av-eye '+side;
    face.append(eye);
  }
  const mouth=document.createElement('span');mouth.className='av-mouth';face.append(mouth);
  const bangs=document.createElement('div');bangs.className='av-bangs';
  const ribbon=document.createElement('div');ribbon.className='av-ribbon';
  root.append(hair,outfit,face,bangs,ribbon);
  // Only the user's own authored model can wear their uploaded artwork.
  // A trained version uses its own blueprint image, never the global artwork.
  const ownArtwork=fighter.slot==='mine' && fighter.choice==='self' &&
    (fighter.kind==='authored_companion' || fighter.kind==='standard_mine');
  const trainedArtwork=fighter.kind==='trained_practice_only' &&
    /^bp_[a-f0-9]{32}$/.test(fighter.source_draft_id||'');
  if(ownArtwork || trainedArtwork){
    const portrait=document.createElement('img');
    portrait.className='av-image';
    // The parent already has role=img and an accessible name.
    portrait.alt='';
    portrait.loading='lazy';
    portrait.decoding='async';
    portrait.width=106;
    portrait.height=146;
    portrait.onload=()=>{
      root.dataset.artwork='loaded';
      root.setAttribute('aria-label',fighter.name+'。'+persona.label+
        'の予測モデル。保存したイラストを表示中');
    };
    portrait.onerror=()=>{
      portrait.remove();
      root.dataset.artwork='fallback';
      root.setAttribute('aria-label',fighter.name+'。'+persona.label+
        'の予測モデル。イラスト未登録のため簡易2Dキャラを表示中');
    };
    portrait.src=ownArtwork ? '/api/artwork/image/base' :
      '/api/appearance/image/'+fighter.source_draft_id;
    root.append(portrait);
  }
  return root;
}
function dayReaction(fighter,prevPrice,nextPrice,signal){
  if(nextPrice===prevPrice)return {mood:'thinking',line:'価格は横ばい。次の変化を観察しているよ。'};
  if(signal==='LONG' && nextPrice>prevPrice)return {
    mood:'cheer',line:'上昇を予測！ 価格も上昇したよ。'};
  if(signal==='LONG')return {
    mood:'concern',line:'上昇を予測したけれど、価格は下落。'};
  if(nextPrice<prevPrice)return {
    mood:'cheer',line:'現金待機で下落を回避したよ。'};
  return {mood:'thinking',line:'現金待機だったけれど、価格は上がったね。'};
}
function showDay(index){
  if(!match||index<0||index>=12)return;
  activeDay=index;
  for(const [i,node] of [...$('arenaDays').children].entries()){
    node.setAttribute('aria-pressed',String(i===index));
  }
  const box=$('arenaDayDetail');
  box.replaceChildren();
  const title=document.createElement('strong');
  title.textContent=(index+1)+'日目 · 架空価格 '+coins(match.prices[index+1]);
  box.append(title);
  for(const slot of match.ranking){
    const model=match.fighters[slot];
    const p=document.createElement('p');
    p.textContent=model.name+'：'+(model.signals[index]==='LONG'?'上昇を予測して保有':'現金待機')+
      ' ／ '+coins(model.equity_path[index+1])+'コイン';
    box.append(p);
    const actor=actorViews.get(slot);
    if(actor){
      const reaction=dayReaction(model,match.prices[index],match.prices[index+1],model.signals[index]);
      actor.avatar.dataset.mood=reaction.mood;
      actor.voice.textContent=(index+1)+'日目：'+reaction.line;
    }
  }
}
function drawChart(data){
  const svg=$('arenaChart'), ns='http://www.w3.org/2000/svg';
  svg.replaceChildren();
  const all=Object.values(data.fighters).flatMap(f=>f.equity_path);
  const low=Math.min(...all), high=Math.max(...all);
  const spread=Math.max(high-low,1);
  const x=i=>56+i*(555/12);
  const y=value=>178-(value-low)/spread*138;
  const element=(name,attrs)=>{
    const node=document.createElementNS(ns,name);
    for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
    svg.append(node);
    return node;
  };
  for(let i=0;i<3;i++){
    const yy=40+i*69;
    element('line',{x1:48,x2:614,y1:yy,y2:yy,stroke:'#415675','stroke-width':1});
  }
  const colors={mine:'#a4f2cd',owl:'#f8cd91',turtle:'#a9caff'};
  for(const slot of SLOTS){
    const f=data.fighters[slot];
    const points=f.equity_path.map((v,i)=>x(i).toFixed(1)+','+y(v).toFixed(1)).join(' ');
    const line=element('polyline',{points,fill:'none',stroke:colors[slot],
      'stroke-width':3,'stroke-linejoin':'round','stroke-linecap':'round'});
    const title=document.createElementNS(ns,'title');
    title.textContent=f.name+'の残高推移';line.append(title);
  }
  const label=(textValue,px,py)=>{
    const t=element('text',{x:px,y:py,fill:'#bfd3e9','font-size':12});
    t.textContent=textValue;
  };
  label('1日目',56,201);
  label('12日目',557,201);
  label('高 '+coins(high),56,23);
  label('低 '+coins(low),330,23);
}
function showResult(data) {
  if(data?.mode!=='PRACTICE_SYNTHETIC_ONLY'||data.comparison_only!==true||
     data.xp_awarded!==false||data.gear_applied!==false||
     data.period_steps!==12||!Array.isArray(data.prices)||data.prices.length!==13||
     !data.prices.every(Number.isFinite)||
     !Array.isArray(data.ranking)||data.ranking.length!==3||
     new Set(data.ranking).size!==3||!data.ranking.every(slot=>SLOTS.includes(slot))||
     !SLOTS.every(slot=>{
       const fighter=data.fighters?.[slot];
       return fighter&&typeof fighter.name==='string'&&
         fighter.persona&&typeof fighter.persona.label==='string'&&
         typeof fighter.persona.nature==='string'&&
         fighter.persona.look&&typeof fighter.persona.look.hair_color==='string'&&
         Number.isFinite(fighter.return_pct)&&Number.isFinite(fighter.profit_coins)&&
         Number.isFinite(fighter.max_drawdown_pct)&&
         Array.isArray(fighter.equity_path)&&fighter.equity_path.length===13&&
         fighter.equity_path.every(Number.isFinite)&&
         Array.isArray(fighter.signals)&&fighter.signals.length===12&&
         fighter.signals.every(v=>v==='LONG'||v==='CASH');
     }))throw Error('比較結果の形式が不正です');
  match=data;
  $('arenaOutput').hidden=false;
  $('arenaSummary').textContent='同じ12日・各'+coins(data.initial_coins_per_model)+
    'コイン・手数料'+coins(data.fee_rate_pct)+'%。買って保有した場合：'+
    signed(data.benchmark_buy_hold_pct)+'%。XPなし、架空データのみ。';
  drawChart(data);
  const container=$('arenaStandings');
  container.replaceChildren();
  actorViews.clear();
  for(const [position,slot] of data.ranking.entries()){
    const f=data.fighters[slot];
    const article=document.createElement('article');
    article.className='arena-fighter';
    const avatar=buildAvatar(f);
    const info=document.createElement('div');
    info.className='arena-fighter-info';
    const title=document.createElement('strong');
    title.textContent=(position+1)+'位 · '+f.name;
    info.append(title);
    const trait=document.createElement('p');
    trait.className='arena-trait';
    trait.textContent='🧠 '+f.persona.label+'：'+f.persona.nature+
      '（実際の予測配分から自動設定）';
    info.append(trait);
    const metrics=document.createElement('div');
    metrics.className='arena-metrics';
    const metricsData=[
      ['仮想損益',signed(f.profit_coins)+' C'],
      ['収益率',signed(f.return_pct)+'%'],
      ['最大下落率',coins(f.max_drawdown_pct)+'%'],
      ['売買回数',coins(f.trades)+'回'],
    ];
    for(const [label,value] of metricsData){
      const span=document.createElement('span');
      span.textContent=label+'：'+value;
      metrics.append(span);
    }
    info.append(metrics);
    const note=document.createElement('small');
    note.textContent=f.kind==='trained_practice_only'?
      '保存学習版 '+f.version_id+' · 固定架空40点で学習':
      f.kind==='authored_companion'?'自分で設定した予測ルール':
      f.kind==='standard_mine'?'標準モデル':'既存の比較用モデル';
    info.append(note);
    const voice=document.createElement('p');
    voice.className='arena-voice';
    voice.textContent='今日の予測を見てみよう！';
    info.append(voice);
    actorViews.set(slot,{avatar,voice});
    article.append(avatar,info);
    container.append(article);
  }
  const dayButtons=$('arenaDays');
  dayButtons.replaceChildren();
  for(let i=0;i<12;i++){
    const button=document.createElement('button');
    button.type='button';button.textContent=String(i+1);
    button.setAttribute('aria-label',(i+1)+'日目の判断を比較');
    button.addEventListener('click',()=>showDay(i));
    dayButtons.append(button);
  }
  showDay(0);
}
async function compare(){
  if(busy)return;
  const chosen=choices();
  const ids=Object.values(chosen).filter(v=>TRAINED.test(v));
  if(new Set(ids).size!==ids.length){
    status('同じ学習版を2体に指定できません。別のモデルを選んでください。');
    return;
  }
  busy=true;controls();
  $('arenaOutput').hidden=true;
  match=null;
  status('同じ架空相場で3モデルを計算しています…');
  try{
    const data=await get('/api/compare',{contenders:chosen});
    if(!SLOTS.every(slot=>data.fighters?.[slot]?.choice===chosen[slot])) {
      throw Error('選択モデルと比較結果が一致しません');
    }
    showResult(data);
    status('比較完了。順位は固定架空12日間の仮想損益によるもので、予測精度の実績ではありません。');
  }catch(error){
    $('arenaOutput').hidden=true;
    status('比較できません: '+error.message);
  }finally{busy=false;controls();}
}
$('arenaLoad').addEventListener('click',loadModels);
$('arenaRun').addEventListener('click',compare);
controls();
