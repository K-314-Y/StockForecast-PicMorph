const API='/api/accessory-analysis/v1';
const FOCUS={trend:'値動きの流れ',momentum:'直近の勢い',volatility:'値動きの大きさ',reversion:'行き過ぎ後の戻り'};
const $=id=>document.getElementById(id);
const settings=$('settings');
const save=$('save');
const compare=$('compare');
const reload=$('reload');
const status=$('status');
const result=$('result');
let state;
let controls=[];
let busy=false;
let refreshRequired=false;

async function request(path='',input) {
  const response=await fetch(API+path,{mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',
    signal:AbortSignal.timeout(20000),...(input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})});
  const body=await response.json();
  if(!response.ok)throw Object.assign(new Error(body.error || '分析実験を実行できませんでした'),{status:response.status});
  return body;
}

function editedPolicies() {
  return controls.filter(({focus})=>focus.value).map(({kind_id,focus,intensity})=>({kind_id,focus:focus.value,intensity:Number(intensity.value)}));
}

function updateControls() {
  const changed=state && (state.stale_kinds.length || JSON.stringify(editedPolicies())!==JSON.stringify(state.policies));
  save.disabled=busy || refreshRequired || !changed;
  compare.disabled=busy || refreshRequired || !state?.equipped.character_id || Boolean(changed);
  reload.disabled=busy;
  for(const {focus,intensity} of controls) {
    focus.disabled=busy || refreshRequired;
    intensity.disabled=focus.disabled || !focus.value;
  }
}

function select(label,options,value) {
  const wrapper=document.createElement('label');
  const input=document.createElement('select');
  for(const [id,text] of options)input.add(new Option(text,id));
  input.value=value;
  wrapper.append(label,input);
  return {wrapper,input};
}

function renderSettings() {
  settings.replaceChildren();
  const saved=new Map(state.policies.map(policy=>[policy.kind_id,policy]));
  controls=state.kinds.map(({kind_id})=>{
    const policy=saved.get(kind_id);
    const field=document.createElement('fieldset');
    const legend=document.createElement('legend');
    legend.textContent=kind_id;
    const fields=document.createElement('div');
    fields.className='controls';
    const focus=select('分析の焦点',[['','未設定'],...Object.entries(FOCUS)],policy?.focus ?? '');
    const intensity=select('強度',[['1','1'],['2','2'],['3','3']],String(policy?.intensity ?? 1));
    fields.append(focus.wrapper,intensity.wrapper);
    field.append(legend,fields);
    settings.append(field);
    return {kind_id,focus:focus.input,intensity:intensity.input};
  });
  const {character_id,visible_kinds}=state.equipped;
  $('equipped').textContent=character_id
    ? `表示中の装備の種類　${visible_kinds.join('、') || 'なし'}`
    : '比較するにはゲームで登録キャラを選び、設定を再読込してください。';
  const notes=[];
  if(!state.kinds.length)notes.push('カタログに登録された装飾品はありません。');
  if(state.stale_kinds.length)notes.push(`カタログにない種類　${state.stale_kinds.join('、')}。保存し直すと該当する設定が削除されます。`);
  $('catalog-note').textContent=notes.join(' ');
  $('catalog-note').hidden=!notes.length;
}

function renderComparison(report) {
  $('delta').textContent=`異なる日次シグナルは12日中${report.difference.different_signals}日。架空収支の差は${report.difference.profit_coins}コイン。分析重みは${report.weights_changed?'変更あり':'変更なし'}、モデルハッシュは${report.effective_hash_changed?'変更あり':'変更なし'}。`;
  const applied=report.provenance.applied_rules.map(policy=>`${policy.kind_id}（${FOCUS[policy.focus]}・強度${policy.intensity}）`);
  $('rules').textContent=`適用した設定　${applied.join('、') || 'なし'}`;
  $('reports').replaceChildren();
  for(const [title,data] of [['基準',report.baseline],['候補',report.candidate]]) {
    const article=document.createElement('article');
    const heading=document.createElement('h3');
    heading.textContent=title;
    article.append(heading);
    for(const line of [Object.entries(FOCUS).map(([id,name])=>`${name} ${data.parameters.plugin_weights[id]}%`).join('、'),
      `モデルハッシュ　${data.effective_sha256}`,`架空収支　${data.profit_coins}コイン`,
      `収益率　${data.return_pct}%`,`最大下落率　${data.max_drawdown_pct}%`,
      `日次シグナル　${data.signals.join(' / ')}`]) {
      const p=document.createElement('p');
      p.textContent=line;
      article.append(p);
    }
    $('reports').append(article);
  }
  result.hidden=false;
}

async function run(message,action) {
  busy=true;
  result.hidden=true;
  status.textContent=message;
  updateControls();
  try { await action(); }
  catch(error) {
    if(error.status===409)refreshRequired=true;
    status.textContent=error.status?error.message:'接続に失敗しました。設定を再読込してください。';
  } finally {
    busy=false;
    updateControls();
  }
}

function load() {
  refreshRequired=true;
  return run('設定を読み込んでいます…',async()=>{
    state=await request();
    renderSettings();
    refreshRequired=false;
    status.textContent='設定を読み込みました。';
  });
}

settings.addEventListener('change',()=>{result.hidden=true;updateControls();});
reload.addEventListener('click',load);
save.addEventListener('click',()=>{
  if(!window.confirm('種類別の分析設定を保存しますか？ 装備や予測モデルは変更しません。'))return;
  void run('分析設定を保存しています…',async()=>{
    const saved=await request('',{expected_revision:state.revision,policies:editedPolicies()});
    state={...state,...saved,stale_kinds:[]};
    renderSettings();
    status.textContent='分析設定を保存しました。';
  });
});
compare.addEventListener('click',()=>{
  void run('同じ架空12日間で比較しています…',async()=>{
    const {character_id,active_revision,equipment_revision}=state.equipped;
    renderComparison(await request('/compare',{character_id,active_revision,equipment_revision,expected_revision:state.revision}));
    status.textContent='比較が完了しました。';
  });
});
void load();
