/** Manual variables lab; ephemeral comparisons only. No model, XP or coin writes. */
const $=id=>document.getElementById(id);
const INDICATORS=['trend','momentum','volatility','reversion'];
const SUFFIX={trend:'Trend',momentum:'Momentum',volatility:'Volatility',reversion:'Reversion'};
const INPUTS=['labFast','labSlow','labRisk',...INDICATORS.flatMap(k=>[
  'labWeight'+SUFFIX[k],'labStrength'+SUFFIX[k]])];
let baseline=null;
let processing=false;
const visited=new Set();

function msg(value){$('labStatus').textContent=value;}
function num(id){const field=$(id);return field.value.trim()===''?NaN:Number(field.value);}
function candidate(){
  return {
    fast_window:num('labFast'),slow_window:num('labSlow'),
    risk_fraction:num('labRisk')/100,
    plugin_weights:Object.fromEntries(INDICATORS.map(k=>[k,num('labWeight'+SUFFIX[k])])),
    plugin_strengths:Object.fromEntries(INDICATORS.map(k=>[k,num('labStrength'+SUFFIX[k])])),
  };
}
function validate(show=false){
  const nodes=INPUTS.map(id=>$(id));
  const invalid=nodes.filter(node=>{
    const bad=node.value.trim()===''||!node.validity.valid||!Number.isInteger(Number(node.value));
    if(show || visited.has(node.id))node.setAttribute('aria-invalid',String(bad));
    else node.removeAttribute('aria-invalid');
    return bad;
  });
  const fast=num('labFast'),slow=num('labSlow');
  const windowInvalid=!Number.isInteger(fast)||!Number.isInteger(slow)||fast>=slow;
  const total=INDICATORS.reduce((n,k)=>n+num('labWeight'+SUFFIX[k]),0);
  const weightInvalid=!Number.isInteger(total)||total!==100;
  $('labWeightTotal').textContent=Number.isFinite(total)?
    '分析の配分合計：'+total+'％ / 100％'+(weightInvalid?'（合計を調整してください）':'（OK）'):
    '分析の配分合計：未入力';
  const valid=baseline!==null && !processing && invalid.length===0 &&
    !windowInvalid && !weightInvalid;
  $('labRun').disabled=!valid;
  for(const id of ['labPresetTrend','labPresetReversion','labPresetBalanced'])
    $(id).disabled=processing||baseline===null;
  for(const id of INPUTS)$(id).disabled=processing||baseline===null;
  $('labLoad').disabled=processing;
  if(windowInvalid && !invalid.some(x=>x.id==='labFast'||x.id==='labSlow')){
    for(const id of ['labFast','labSlow'])if(show || visited.has(id))
      $(id).setAttribute('aria-invalid','true');
  }
  return {valid,windowInvalid,weightInvalid};
}
function fromModel(model){
  $('labFast').value=String(model.fast_window);
  $('labSlow').value=String(model.slow_window);
  $('labRisk').value=String(Math.round(model.risk_fraction*100));
  for(const k of INDICATORS){
    $('labWeight'+SUFFIX[k]).value=String(model.plugin_weights[k]);
    $('labStrength'+SUFFIX[k]).value=String(model.plugin_strengths[k]);
  }
}
async function api(path,body){
  const response=await fetch(path,body?{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  }:undefined);
  let data;
  try{data=await response.json();}catch{throw Error('サーバーの応答が読めません');}
  if(!response.ok)throw Error(data.error||'通信に失敗しました');
  return data;
}
async function loadBaseline(){
  if(processing)return;
  processing=true;baseline=null;visited.clear();
  $('labResult').hidden=true;validate();
  msg('相棒の変数を読み込んでいます…');
  try{
    const data=await api('/api/model-lab/baseline');
    if(!data.model||!data.revisions)throw Error('モデルの情報が不足しています');
    baseline=data;
    fromModel(data.model);
    $('labBasis').textContent=(data.source==='authored_companion'?
      '保存済みの自作相棒':'標準モデル')+'を基準にしています（装備補正なし）';
    msg('変数を調整して比較できます。ここでの変更は保存されません。');
    validate();
  }catch(error){
    $('labBasis').textContent='基準モデルの読込に失敗しました';
    msg('変数を読み込めません: '+error.message);
    validate();
  }finally{
    processing=false;validate();
  }
}
function setPreset(weights){
  for(const k of INDICATORS)
    $('labWeight'+SUFFIX[k]).value=String(weights[k]);
  onEdit();
}
function onEdit(){
  $('labResult').hidden=true;
  const result=validate();
  if(result.valid)msg('比較する準備ができました。結果は未保存の一時実験です。');
  else if(result.weightInvalid)msg('4つの分析の配分合計を100％にしてください。');
  else if(result.windowInvalid)msg('短期・長期の期間を確認してください（短期は長期より小さく）。');
  else msg('入力を確認してください。空欄や範囲外の数値は使えません。');
}
function signed(value,unit=''){
  const n=Number(value);
  return (n>0?'+':'')+n.toLocaleString('ja-JP',{maximumFractionDigits:2})+unit;
}
function summary(r){
  return '仮想損益：'+signed(r.profit_coins,' C')+
    ' / 収益率：'+signed(r.return_pct,'%')+
    ' / 最大下落率：'+signed(r.max_drawdown_pct,'%')+
    ' / 売買回数：'+r.trades+
    ' / 手数料：'+signed(r.fees,' C');
}
function appendText(parent,tag,value){
  const el=document.createElement(tag);el.textContent=value;parent.append(el);return el;
}
function render(data){
  if(data.mode!=='PRACTICE_SYNTHETIC_ONLY' ||
     data.scope!=='MODEL_VARIABLES_FIXED_SYNTHETIC_12' ||
     data.comparison_only!==true||data.save_performed!==false||
     data.xp_awarded!==false||data.holdout_evaluated!==false||
     !Array.isArray(data.baseline?.signals)||data.baseline.signals.length!==12||
     !Array.isArray(data.candidate?.signals)||data.candidate.signals.length!==12)
    throw Error('比較結果の形式が不正です');
  $('labOriginalSummary').textContent=summary(data.baseline);
  $('labCandidateSummary').textContent=summary(data.candidate);
  $('labDifference').textContent='変更後と変更前の差：損益 '+signed(data.difference.profit_coins,' C')+
    '、収益率 '+signed(data.difference.return_pct,'%')+
    '、最大下落率 '+signed(data.difference.drawdown_pct,'%')+
    '。判断が異なる日：'+data.difference.different_signals+'/12日。' +
    'この架空相場での差であり、強さの証明ではありません。';
  const table=document.createElement('table');
  const thead=document.createElement('thead'),head=document.createElement('tr');
  for(const label of ['日','変更前','変更後','違い']){
    const th=appendText(head,'th',label);th.scope='col';
  }
  thead.append(head);table.append(thead);
  const tbody=document.createElement('tbody');
  const signalText=v=>v==='LONG'?'上昇予測（保有）':'現金待機';
  for(let i=0;i<12;i++){
    const original=data.baseline.signals[i],changed=data.candidate.signals[i];
    if(!['LONG','CASH'].includes(original)||!['LONG','CASH'].includes(changed))
      throw Error('比較結果の判断が不正です');
    const tr=document.createElement('tr');
    tr.dataset.different=String(original!==changed);
    appendText(tr,'th',String(i+1)).scope='row';
    appendText(tr,'td',signalText(original));
    appendText(tr,'td',signalText(changed));
    appendText(tr,'td',original===changed?'同じ':'異なる');
    tbody.append(tr);
  }
  table.append(tbody);
  $('labDayTable').replaceChildren(table);
  $('labResult').hidden=false;
}
async function compare(event){
  event.preventDefault();
  if(processing||!baseline)return;
  const state=validate(true);
  if(!state.valid){
    msg('入力を確認してください。分析配分の合計と短期・長期を確かめてください。');
    return;
  }
  const proposal=candidate();
  processing=true;validate();
  $('labResult').hidden=true;
  msg('基準モデルと調整したモデルを、同じ架空12日で比較しています…');
  try{
    const result=await api('/api/model-lab/compare',{
      candidate:proposal,revisions:baseline.revisions,
    });
    render(result);
    msg('比較できました。どの変数を変えたかと、判断や下落幅の違いを確認してください。');
  }catch(error){
    msg('比較できません: '+error.message+'。基準モデルが変わった場合は再読込してください。');
  }finally{
    processing=false;validate();
  }
}
$('labForm').addEventListener('submit',compare);
$('labLoad').addEventListener('click',loadBaseline);
for(const id of INPUTS){
  $(id).addEventListener('input',onEdit);
  $(id).addEventListener('blur',()=>{visited.add(id);validate();});
}
$('labPresetTrend').addEventListener('click',()=>setPreset({
  trend:50,momentum:30,volatility:10,reversion:10,
}));
$('labPresetReversion').addEventListener('click',()=>setPreset({
  trend:15,momentum:10,volatility:20,reversion:55,
}));
$('labPresetBalanced').addEventListener('click',()=>setPreset({
  trend:25,momentum:25,volatility:25,reversion:25,
}));
validate();
