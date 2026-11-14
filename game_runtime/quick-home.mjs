/** Beginner-only flow. Uses 12 synthetic days; never places real orders. */
const element = id => document.getElementById(id);
const BALANCE = 10000;
const money = value => Number(value).toLocaleString('ja-JP',{maximumFractionDigits:2});
let pending = null;
let busy = false;
let touched = false;
const amountField = element('quickAmount');
const modelField = element('quickModel');
const leverageField = element('quickLeverage');
const errorField = element('quickError');
// Native dropdown: all integer settings, without adding another slider.
for (let n=2; n<=25; n++) {
  const option=document.createElement('option');
  option.value=String(n);
  option.textContent='×'+n+(n===25?'（最大）':'');
  leverageField.append(option);
}
leverageField.value='1';
function validLeverage(){
  const value=Number(leverageField.value);
  return /^\d+$/.test(leverageField.value) && Number.isInteger(value) &&
    value>=1 && value<=25 ? value : null;
}
function showLeverageInfo(){
  const n=validLeverage();
  element('quickLeverageHelp').textContent=n===null ? '倍率を1〜25から選んでください。' :
    n>=10 ? '×'+n+'：利益も損失も大きくなります。試算額が0になればその時点で終了し、後から回復しても復活しません。' :
    '利益・損失の両方に×'+n+'を適用。最大損失は試算額まで。実際の信用・FX取引とは異なります。';
}
showLeverageInfo();
const statusField = element('quickStatus');

function validAmount() {
  const raw = amountField.value.trim();
  const amount = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(amount) && amount>=1 && amount<=BALANCE ?
    amount : null;
}
function renderValidation(showError=false) {
  const amount = validAmount();
  element('quickRemaining').textContent = amount===null ? '試算に使わないコイン：入力を確認してください' :
    '試算に使わないコイン：'+money(BALANCE-amount)+' C';
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
  element('quickNext').hidden=true;
  renderValidation(touched);
}
function scrollAndFocus(sectionId,focusId) {
  element(sectionId).scrollIntoView?.({block:'start'});
  const target=element(focusId);
  if(focusId==='modelShopTitle'||focusId==='companionEditorTitle')
    target.setAttribute('tabindex','-1');
  target.focus?.({preventScroll:true});
}
function openShop() {
  element('advancedEntry').open=true;
  scrollAndFocus('modelShopSection','modelShopTitle');
}
function openEditor() {
  element('advancedEntry').open=true;
  element('companionControls').open=true;
  scrollAndFocus('companionEditorTitle','companionEditorTitle');
}
async function returnHome() {
  scrollAndFocus('simpleHome','quickModel');
  await loadModels();
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
  try {
    const data=await request('/api/model-shop');
    const next=[{id:'self',name:'自分のAI（未作成なら標準AI）'}];
    for(const model of data.models || []) {
      if(model.owned && typeof model.id==='string' && typeof model.name==='string')
        next.push({id:model.id,name:model.name+'（解放済み）'});
    }
    const prior=modelField.value;
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
  for(const id of ['quickConfirm','quickRun','quickEdit','quickAll','quickModel','quickAmount','quickLeverage'])
    element(id).disabled=next;
}
element('quickForm').addEventListener('submit',event=>{
  event.preventDefault();
  if(busy)return;
  touched=true;
  renderValidation(true);
  const amount=validAmount();
  if(amount===null){amountField.focus();return;}
  const leverage=validLeverage();
  if(leverage===null){errorField.textContent='倍率は1〜25の整数を選んでください。';leverageField.focus();return;}
  const option=modelField.selectedOptions[0];
  if(!option) return;
  pending={amount,leverage,model_id:modelField.value,model_name:option.textContent};
  element('quickReviewText').textContent=
    'AI：'+pending.model_name+' ／ 試算額：'+money(amount)+' C ／ 損益倍率：×'+leverage+
    ' ／ 試算に使わないコイン：'+money(BALANCE-amount)+
    ' C。最大損失は'+money(amount)+' C。実際の注文ではなく12日間の練習です。';
  element('quickReview').hidden=false;
  element('quickResult').hidden=true;
  element('quickNext').hidden=true;
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
leverageField.addEventListener('change',()=>{showLeverageInfo();resetReview();});
element('quickShop').addEventListener('click',openShop);
element('quickNextShop').addEventListener('click',openShop);
element('quickCustomize').addEventListener('click',openEditor);
element('shopReturn').addEventListener('click',returnHome);
element('companionReturn').addEventListener('click',returnHome);
element('quickAgain').addEventListener('click',()=>{
  if(busy)return;
  resetReview();
  scrollAndFocus('simpleHome','quickAmount');
});
element('quickRun').addEventListener('click',async()=>{
  if(busy||!pending)return;
  const ordered=pending;
  pending=null;
  element('quickReview').hidden=true;
  element('quickResult').hidden=true;
  element('quickNext').hidden=true;
  setBusy(true);
  statusField.textContent='AIの判断と架空12日間の損益を計算しています…';
  try{
    const value=await request('/api/quick-practice',{
      model_id:ordered.model_id,amount:ordered.amount,leverage:ordered.leverage});
    if(value.mode!=='SIMPLE_SYNTHETIC_PRACTICE_ONLY'||value.real_market!==false||
       value.persisted!==false||value.invested_coins!==ordered.amount||
       value.leverage!==ordered.leverage ||
       !Number.isFinite(value.final_balance)||!Number.isFinite(value.profit_coins)||
       value.final_balance<0 || value.profit_coins < -ordered.amount ||
       !(value.liquidated_at_step===null ||
         (Number.isInteger(value.liquidated_at_step) && value.liquidated_at_step>=1 &&
          value.liquidated_at_step<=12)))
      throw Error('練習結果の形式が不正です');
    const panel=element('quickResult');
    panel.replaceChildren();
    const heading=document.createElement('h3');
    heading.textContent='12日間の試算結果';
    const summary=document.createElement('p');
    summary.textContent='試算額：'+money(ordered.amount)+' C ／ 損益倍率：×'+
      ordered.leverage+' ／ 損益：'+(value.profit_coins>=0?'+':'')+
      money(value.profit_coins)+' C ／ 終了時：'+
      money(value.final_balance)+' C（試算に使わないコインを含む）';
    const footnote=document.createElement('p');
    footnote.textContent='試算した資金の最大下落率 '+money(value.max_drawdown_pct)+
      '%。'+(value.liquidated_at_step===null ? '' :
        '第'+value.liquidated_at_step+'日で資金が尽き、以降は強制終了。')+
      '強制終了は日足終値だけの近似です。実際の注文は行いません。結果は保存されず、実際の株価・所持コイン・XPには影響しません。';
    footnote.className='simple-hint';
    panel.append(heading,summary,footnote);
    panel.hidden=false;
    element('quickNext').hidden=false;
    statusField.textContent='試算が完了しました。AI・試算額・倍率を変えてもう一度試せます。';
  }catch(error){
    element('quickResult').hidden=true;
    element('quickNext').hidden=true;
    statusField.textContent='試算できませんでした：'+error.message;
  }finally{setBusy(false);}
});
renderValidation();
loadModels();
element('advancedEntry').addEventListener('toggle',()=>{
  if(!element('advancedEntry').open && !busy)loadModels();
});
