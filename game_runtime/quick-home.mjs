/** Beginner-only flow. Uses 12 synthetic days; never places real orders. */
const element = id => document.getElementById(id);
const BALANCE = 10000;
const money = value => Number(value).toLocaleString('ja-JP',{maximumFractionDigits:2});
let replay = null;
let replayDay = 0;
let replayHighlights = null;
const highlightButtons = [['quickBestDay','一番増えた日'],['quickWorstDay','一番減った日']];
function findReplayHighlights(balances,liquidatedAt) {
  let best=null,worst=null;
  const last=Number.isInteger(liquidatedAt)?liquidatedAt:12;
  for(let day=1;day<=last;day++) {
    const delta=balances[day]-balances[day-1];
    if(delta>0 && (!best || delta>best.delta))best={day,delta};
    if(delta<0 && (!worst || delta<worst.delta))worst={day,delta};
  }
  return [best,worst];
}
const signedMoney = value => (value>=0?'+':'')+money(value);
function clearReplay() {
  replay=null;
  replayHighlights=null;
  for(const [id,label] of highlightButtons) {
    const button=element(id);
    if(document.activeElement===button)button.blur?.();
    button.disabled=true;
    button.textContent=label;
  }
  replayDay=0;
  element('quickReplay').hidden=true;
  element('quickReplayDay').textContent='';
  element('quickReplayContext').textContent='';
  element('quickPrevious').disabled=true;
  element('quickFollowing').disabled=true;
}
function renderReplay() {
  if(!replay)return;
  const balance=replay.daily_balances[replayDay];
  element('quickReplayDay').textContent='第'+replayDay+'日（0〜12日） ／ 練習用の全残高：'+
    money(balance)+' C ／ 累計損益：'+signedMoney(balance-BALANCE)+
    ' C ／ 前日比：'+(replayDay===0 ? '算出できません（開始日）' :
      signedMoney(balance-replay.daily_balances[replayDay-1])+' C')+
    (replay.liquidated_at_step!==null && replayDay>=replay.liquidated_at_step ?
      '。投入した資金は尽きました。投入しなかった残高は'+money(BALANCE-replay.invested_coins)+' C残っています。' : '');
  const price=replay.daily_synthetic_prices[replayDay];
  const stopped=replay.liquidated_at_step;
  element('quickReplayContext').textContent=replayDay===0 ?
    '開始前 ／ AI判断なし ／ 架空の開始価格：'+money(price) :
    (stopped!==null && replayDay>stopped ?
      '強制終了後なので、この日のAIの方針は運用に使われていません' :
      'AIの方針：'+(replay.daily_ai_signals[replayDay-1]==='LONG'?'株を持つ':'現金で待機')+
      '（売買の実行を示すものではありません）')+
    ' ／ 架空の終値：'+money(price)+' ／ 株価の前日終値比：'+
    ((price/replay.daily_synthetic_prices[replayDay-1]-1)>=0?'+':'')+
    ((price/replay.daily_synthetic_prices[replayDay-1]-1)*100).toFixed(2)+'%'+
    (stopped===replayDay?'。この日の終値で投入資金の運用は強制終了しました。':'');
  element('quickPrevious').disabled=replayDay===0;
  element('quickFollowing').disabled=replayDay===12;
  element('quickReplay').hidden=false;
}
for(const [id,delta] of [['quickPrevious',-1],['quickFollowing',1]]) {
  element(id).addEventListener('click',()=>{
    if(!replay)return;
    replayDay=Math.max(0,Math.min(12,replayDay+delta));
    renderReplay();
  });
}
for(const [index,[id]] of highlightButtons.entries()) {
  element(id).addEventListener('click',()=>{
    const highlight=replayHighlights?.[index];
    if(!replay || !highlight)return;
    replayDay=highlight.day;
    renderReplay();
  });
}
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
    '利益・損失の両方に×'+n+'を適用し、最大損失は試算額まで。倍率でAIの売買は変わらず、試算額が0になるとその後も戻りません。';
}
showLeverageInfo();
const statusField = element('quickStatus');

function validAmount() {
  const raw = amountField.value.trim();
  const amount = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(amount) && amount>=1 && amount<=BALANCE ?
    amount : null;
}
// Display-only approximation; settlement and fees remain the server's responsibility.
function riskText(amount,leverage) {
  if(amount===null || leverage===null)return '入力値を確認してください。試算額は1〜10,000の整数、倍率は1〜25を選んでください。';
  return '練習用10,000 Cの'+money(amount/BALANCE*100)+'%（'+money(amount)+'C）を使う。'+
    '今回の最大損失は'+money(amount)+'C。この試算で投入しない残り'+money(BALANCE-amount)+'Cは守られる。'+
    (leverage===1 ? '' : '×'+leverage+'では1倍の基準損益が約−'+money(100/leverage)+
      '%で投入分を失うおそれ（基準運用の損失100%÷倍率の目安。手数料の影響や日次判定の近似があり、厳密な閾値ではありません）。');
}
function renderValidation(showError=false) {
  const amount = validAmount();
  element('quickRisk').textContent=riskText(amount,validLeverage());
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
  clearReplay();
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
function openArtwork() {
  element('advancedEntry').open=true;
  element('artworkControls').open=true;
  element('artworkWorkshop').open=true;
  scrollAndFocus('artworkControls','artworkTitle');
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
  for(const id of ['quickConfirm','quickRun','quickEdit','quickTen','quickHalf','quickAll','quickModel','quickAmount','quickLeverage'])
    element(id).disabled=next;
}
element('quickForm').addEventListener('submit',event=>{
  event.preventDefault();
  if(busy)return;
  touched=true;
  resetReview();
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
  element('quickReviewRisk').textContent=riskText(amount,leverage);
  element('quickReview').hidden=false;
  element('quickResult').hidden=true;
  element('quickNext').hidden=true;
  statusField.textContent='内容を確認してから練習を実行できます。';
});
for(const [id,ratio] of [['quickTen',0.1],['quickHalf',0.5],['quickAll',1]]) {
  element(id).addEventListener('click',()=>{
    if(busy)return;
    amountField.value=String(BALANCE*ratio);
    touched=true;
    resetReview();
  });
}
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
element('quickGrow').addEventListener('click',()=>{
  element('advancedEntry').open=true;
  scrollAndFocus('play','play');
});
element('quickCustomize').addEventListener('click',openEditor);
element('quickArtwork').addEventListener('click',openArtwork);
element('artworkReturn').addEventListener('click',()=>scrollAndFocus('simpleHome','quickModel'));
element('shopReturn').addEventListener('click',returnHome);
element('companionReturn').addEventListener('click',returnHome);
element('quickAgain').addEventListener('click',()=>{
  if(busy)return;
  resetReview();
  scrollAndFocus('simpleHome','quickAmount');
});
element('quickRun').addEventListener('click',async()=>{
  if(busy||!pending)return;
  clearReplay();
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
       !Array.isArray(value.daily_ai_signals)||value.daily_ai_signals.length!==12||
       !Array.from(value.daily_ai_signals).every(signal=>signal==='LONG'||signal==='CASH')||
       !Array.isArray(value.daily_synthetic_prices)||value.daily_synthetic_prices.length!==13||
       !Array.from(value.daily_synthetic_prices).every(price=>
         Number.isFinite(price)&&price>0&&price<=1e12)||
       !Array.isArray(value.daily_balances)||value.daily_balances.length!==13||
       !Array.from(value.daily_balances).every(balance=>
         Number.isFinite(balance)&&balance>=0&&balance<=Number.MAX_SAFE_INTEGER)||
       value.daily_balances[0]!==BALANCE||
       Math.abs(value.daily_balances[12]-value.final_balance)>0.01||
       !Number.isFinite(value.final_balance)||!Number.isFinite(value.profit_coins)||
       !Number.isFinite(value.normal_profit_coins)||
       !Number.isFinite(value.normal_final_balance)||
       !Number.isFinite(value.normal_max_drawdown_pct)||
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
    summary.textContent='試算額：'+money(ordered.amount)+' C ／ '+
      (ordered.leverage===1 ? '損益倍率：×1 ／ 損益：' :
        '同じAI・同じ相場・同じ試算額で、通常（×1）の損益：'+
        (value.normal_profit_coins>=0?'+':'')+money(value.normal_profit_coins)+
        ' C ／ ×'+ordered.leverage+'の損益：')+
      (value.profit_coins>=0?'+':'')+money(value.profit_coins)+
      ' C。練習の終了時残高：'+money(value.final_balance)+
      ' C（試算に使わないコインを含む）。';
    const footnote=document.createElement('p');
    footnote.textContent='試算した資金の最大下落率 '+money(value.max_drawdown_pct)+
      '%。'+(value.liquidated_at_step===null ? '' :
        '第'+value.liquidated_at_step+'日で資金が尽き、以降は強制終了。')+
      '強制終了は日足終値だけの近似です。実際の注文は行いません。結果は保存されず、実際の株価・所持コイン・XPには影響しません。';
    footnote.className='simple-hint';
    panel.append(heading,summary,footnote);
    replayHighlights=findReplayHighlights(value.daily_balances,value.liquidated_at_step);
    for(const [index,[id,label]] of highlightButtons.entries()) {
      const highlight=replayHighlights[index];
      element(id).disabled=!highlight;
      element(id).textContent=highlight ?
        label+'：第'+highlight.day+'日（'+signedMoney(highlight.delta)+' C）' :
        (index===0?'増えた日なし':'減った日なし');
    }
    replay=value;
    replayDay=0;
    renderReplay();
    panel.hidden=false;
    element('quickNext').hidden=false;
    statusField.textContent='試算が完了しました。AI・試算額・倍率を変えてもう一度試せます。';
  }catch(error){
    clearReplay();
    element('quickResult').hidden=true;
    element('quickNext').hidden=true;
    statusField.textContent='試算できませんでした：'+error.message;
  }finally{setBusy(false);}
});
clearReplay();
renderValidation();
loadModels();
element('advancedEntry').addEventListener('toggle',()=>{
  if(!element('advancedEntry').open && !busy)loadModels();
});
