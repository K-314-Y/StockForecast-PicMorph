/** Beginner-only flow. Uses 12 synthetic days; never places real orders. */
const element = id => document.getElementById(id);
const BALANCE = 10000;
const money = value => Number(value).toLocaleString('ja-JP',{maximumFractionDigits:2});
let pending = null;
let busy = false;
let touched = false;
const amountField = element('quickAmount');
const modelField = element('quickModel');
const errorField = element('quickError');
const statusField = element('quickStatus');

function validAmount() {
  const raw = amountField.value.trim();
  const amount = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(amount) && amount>=1 && amount<=BALANCE ?
    amount : null;
}
function renderValidation(showError=false) {
  const amount = validAmount();
  element('quickRemaining').textContent = amount===null ? '使わずに残すコイン：入力を確認してください' :
    '使わずに残すコイン：'+money(BALANCE-amount)+' C';
  if (showError && amount===null) {
    errorField.textContent='1〜10,000の整数を入力してください。';
    amountField.setAttribute('aria-invalid','true');
  } else {
    errorField.textContent='';
    amountField.removeAttribute('aria-invalid');
  }
}
function resetReview() {
  pending=null;
  element('quickReview').hidden=true;
  element('quickResult').hidden=true;
  renderValidation(touched);
}
async function request(url,body) {
  const response=await fetch(url,body ? {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  }:undefined);
  const value=await response.json();
  if(!response.ok)throw Error(value?.error||'サーバーの処理に失敗しました');
  return value;
}
async function loadModels() {
  const prior=modelField.value;
  try {
    const data=await request('/api/model-shop');
    const next=[{id:'self',name:'自分のAI（未作成なら標準AI）'}];
    for(const model of data.models || []) {
      if(model.owned && typeof model.id==='string' && typeof model.name==='string')
        next.push({id:model.id,name:model.name+'（解放済み）'});
    }
    modelField.replaceChildren();
    for(const item of next){
      const option=document.createElement('option');
      option.value=item.id;
      option.textContent=item.name;
      modelField.append(option);
    }
    modelField.value=next.some(x=>x.id===prior)?prior:'self';
    statusField.textContent=next.length>1 ?
      '自作AIと、解放済みのAIから選べます。' :
      '自分のAIで始められます。他人のAIは「詳しい機能」のショップで解放できます。';
  } catch {
    statusField.textContent='モデル一覧を読み込めません。自分のAIで練習できます。';
  }
}
function setBusy(next) {
  busy=next;
  for(const id of ['quickConfirm','quickRun','quickEdit','quickAll','quickModel','quickAmount'])
    element(id).disabled=next;
}
element('quickForm').addEventListener('submit',event=>{
  event.preventDefault();
  if(busy)return;
  touched=true;
  renderValidation(true);
  const amount=validAmount();
  if(amount===null){amountField.focus();return;}
  const option=modelField.selectedOptions[0];
  if(!option) return;
  pending={amount,model_id:modelField.value,model_name:option.textContent};
  element('quickReviewText').textContent=
    'AI：'+pending.model_name+' ／ 練習の試算額：'+money(amount)+' C ／ 使わずに残す：'+
    money(BALANCE-amount)+' C。実際の注文ではなく12日間の練習です。';
  element('quickReview').hidden=false;
  element('quickResult').hidden=true;
  statusField.textContent='内容を確認してから練習を実行できます。';
});
element('quickAll').addEventListener('click',()=>{
  amountField.value=String(BALANCE);
  touched=true;
  resetReview();
});
element('quickEdit').addEventListener('click',()=>{
  element('quickReview').hidden=true;
  pending=null;
  amountField.focus();
});
amountField.addEventListener('input',()=>{resetReview();});
amountField.addEventListener('blur',()=>{touched=true;renderValidation(true);});
modelField.addEventListener('change',resetReview);
element('quickRun').addEventListener('click',async()=>{
  if(busy||!pending)return;
  const ordered=pending;
  pending=null;
  element('quickReview').hidden=true;
  setBusy(true);
  statusField.textContent='AIの判断と架空12日間の損益を計算しています…';
  try{
    const value=await request('/api/quick-practice',{
      model_id:ordered.model_id,amount:ordered.amount});
    if(value.mode!=='SIMPLE_SYNTHETIC_PRACTICE_ONLY'||value.real_market!==false||
       value.persisted!==false||value.invested_coins!==ordered.amount||
       !Number.isFinite(value.final_balance)||!Number.isFinite(value.profit_coins))
      throw Error('練習結果の形式が不正です');
    const panel=element('quickResult');
    panel.replaceChildren();
    const heading=document.createElement('h3');
    heading.textContent='12日間の練習結果';
    const summary=document.createElement('p');
    summary.textContent='投資：'+money(ordered.amount)+' C ／ 損益：'+
      (value.profit_coins>=0?'+':'')+money(value.profit_coins)+' C ／ 終了時：'+
      money(value.final_balance)+' C（現金待機分を含む）';
    const footnote=document.createElement('p');
    footnote.textContent='最大下落率 '+money(value.max_drawdown_pct)+
      '%。結果は保存されず、実際の株価・所持コイン・XPには影響しません。';
    footnote.className='simple-hint';
    panel.append(heading,summary,footnote);
    panel.hidden=false;
    statusField.textContent='練習が完了しました。金額を変えてもう一度試せます。';
  }catch(error){
    statusField.textContent='練習できませんでした：'+error.message;
  }finally{setBusy(false);}
});
renderValidation();
loadModels();
element('advancedEntry').addEventListener('toggle',()=>{
  if(!element('advancedEntry').open && !busy)loadModels();
});
