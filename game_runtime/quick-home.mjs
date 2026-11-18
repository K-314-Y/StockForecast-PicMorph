/** Beginner-only flow. Uses 12 synthetic days; never places real orders. */
const element = id => document.getElementById(id);
const BALANCE = 10000;
const money = value => Number(value).toLocaleString('ja-JP',{maximumFractionDigits:2});
let practiceEpoch = 0;
let preReveal = null;
let lastScenarioToken = null;
const validScenarioToken = token => typeof token==='string' && token.length===19 && /^v1_[0-9a-f]{16}$/.test(token);
const scenarioNote = kind => kind==='replay' ?
  '同じ架空相場での再挑戦です。既に値動きを知っている場合、初見の予想とは比較できません。' :
  '今回は新しい架空相場です。';
function updateScenarioOption() {
  element('quickScenarioOption').hidden=!lastScenarioToken;
  element('quickScenarioNote').textContent=scenarioNote(
    lastScenarioToken && element('quickSameScenario').checked ? 'replay' : 'new');
}
element('quickSameScenario').addEventListener('change',updateScenarioOption);
const checkpoints = [3,7,11];
const preBuddyPrompts = [
  '最初の分かれ道だね。ここまでの値動きを見て、どう進もう？',
  '冒険の折り返し。ひと息ついて、次の一歩を選ぼう。',
  '最後の分かれ道だね。自分のペースで選ぼう。',
];
function renderPreBuddyLine(agrees) {
  const {value,ordered,index}=preReveal;
  // Authored copy: no prices, signals, profit or model-generated explanations.
  const owner=ordered.model_id==='self' && value.model_id==='self' ?
    '相棒（定型文）：' : '冒険ガイド（定型文）：';
  const line=agrees===undefined ? preBuddyPrompts[index] : agrees ?
    '同じ選択だったね。値動きも一緒に振り返ろう。' :
    '違う選択だったね。違いも冒険の手がかりにしよう。';
  element('quickPreBuddyLine').textContent=owner+line;
}
function clearPreReveal() {
  practiceEpoch++;
  preReveal=null;
  element('quickPreReveal').hidden=true;
  element('quickPreSummary').hidden=true;
  for(const id of ['quickPreBuddyLine','quickPreSnapshot','quickPreOutcome','quickPreSummary'])element(id).textContent='';
  for(const id of ['quickPreBuy','quickPreWait','quickPreNext','quickPreSkip'])element(id).disabled=true;
  element('quickPreNext').textContent='次へ';
}
function renderPreReveal() {
  const {value,index}=preReveal;
  const day=checkpoints[index];
  renderPreBuddyLine();
  element('quickPreSnapshot').textContent='判断 '+(index+1)+'/3：第'+day+'日 ／ 過去の架空価格：'+
    value.daily_synthetic_prices.slice(day-3,day).map((price,i)=>{
      const pastDay=day-3+i;
      return (pastDay===0?'開始時':'第'+pastDay+'日')+' '+money(price);
    }).join(' ／ ');
  element('quickPreOutcome').textContent='この日のAI判断・価格変化は、選択してから表示します。';
  for(const id of ['quickPreBuy','quickPreWait','quickPreSkip'])element(id).disabled=false;
  element('quickPreNext').disabled=true;
  element('quickPreNext').textContent=index===2 ? '12日間の結果を見る' : '次へ';
  element('quickPreReveal').hidden=false;
  element('quickPreBuy').focus();
}
function finishPreReveal() {
  if(!preReveal)return;
  const {value,ordered,answers}=preReveal;
  preReveal=null;
  element('quickPreReveal').hidden=true;
  element('quickPreBuddyLine').textContent='';
  revealResult(value,ordered);
  const record=answers.length===0 ? '記録なし（未回答は集計しません）' :
    '回答 '+answers.length+'/3回 ／ AI方針との一致 '+
    answers.filter(answer=>answer.agrees).length+'/'+answers.length+'回答。'+
    answers.map(answer=>'第'+answer.day+'日：'+(answer.choice==='buy'?'買う':'待つ')+'（'+(answer.agrees?'一致':'相違')+'）').join(' ／ ')+
    '。未回答は集計しません';
  element('quickPreSummary').textContent='結果を見る前の記録：'+record+'。'+
    (answers.length>0 ? 'AIとの一致数は正解数ではありません。' : '')+
    '利益や実際の投資技能の評価ではありません。'+
    (value.scenario_kind==='replay' ? scenarioNote('replay') : '');
  element('quickPreSummary').hidden=false;
  element('quickPreSummary').focus();
}
for(const [id,choice] of [['quickPreBuy','buy'],['quickPreWait','wait']]) {
  element(id).addEventListener('click',()=>{
    if(!preReveal || preReveal.answers.length!==preReveal.index)return;
    const {value,index,answers}=preReveal;
    const day=checkpoints[index],signal=value.daily_ai_signals[day-1];
    const agrees=(choice==='buy')===(signal==='LONG');
    answers.push({day,choice,agrees});
    renderPreBuddyLine(agrees);
    const change=(value.daily_synthetic_prices[day]/value.daily_synthetic_prices[day-1]-1)*100;
    const price=value.daily_synthetic_prices[day],previous=value.daily_synthetic_prices[day-1];
    const directionVerdict=buy=>price===previous ? '判定なし（価格変化なし）' :
      buy===(price>previous) ? '値動きに合う' : '値動きに合わない';
    element('quickPreOutcome').textContent='第'+day+'日：自分は'+(choice==='buy'?'買う':'待つ')+
      ' ／ AI方針：'+(signal==='LONG'?'株を持つ':'現金で待機')+
      '（売買の実行を示しません） ／ 架空の終値：'+money(value.daily_synthetic_prices[day])+
      ' ／ 架空価格の前日比：'+(change>=0?'+':'')+change.toFixed(2)+'% ／ '+(agrees?'一致':'相違')+
      '。値動きとの比較：自分は'+directionVerdict(choice==='buy')+'、AIは'+directionVerdict(signal==='LONG')+
      '。架空価格の方向だけ。実際の損益や予測の上手さを示しません。';
    for(const button of ['quickPreBuy','quickPreWait','quickPreSkip'])element(button).disabled=true;
    element('quickPreNext').disabled=false;
    element('quickPreNext').focus();
  });
}
element('quickPreNext').addEventListener('click',()=>{
  if(!preReveal || preReveal.answers.length!==preReveal.index+1)return;
  if(preReveal.index===2){finishPreReveal();return;}
  preReveal.index++;
  renderPreReveal();
});
element('quickPreSkip').addEventListener('click',()=>{
  if(preReveal && preReveal.answers.length===preReveal.index)finishPreReveal();
});
let replay = null;
let replayDay = 0;
let replayHighlights = null;
let replayIsSelf = false;
// Module-local ownership: advanced scenes must survive quick-practice cleanup.
let sceneVoice = null;
function clearSceneVoice() {
  if(sceneVoice && element('speech').textContent===sceneVoice.text &&
      element('scene').dataset.mood===sceneVoice.mood) {
    element('speech').textContent=sceneVoice.previous.text;
    if(sceneVoice.previous.mood===undefined)delete element('scene').dataset.mood;
    else element('scene').dataset.mood=sceneVoice.previous.mood;
  }
  sceneVoice=null;
}
function renderSceneVoice(text) {
  if(!replayIsSelf)return;
  const scene=element('scene'),speech=element('speech');
  // If another module took over, its current scene becomes the restore point.
  if(sceneVoice && (speech.textContent!==sceneVoice.text || scene.dataset.mood!==sceneVoice.mood))
    sceneVoice=null;
  const previous=sceneVoice?.previous || {text:speech.textContent,mood:scene.dataset.mood};
  const delta=replayDay===0?0:replay.daily_balances[replayDay]-replay.daily_balances[replayDay-1];
  const mood=replay.liquidated_at_step!==null && replayDay>=replay.liquidated_at_step ?
    'cautious' : replayDay===0?'ready':delta<0?'cautious':delta>0?'happy':'thinking';
  speech.textContent=text;
  scene.dataset.mood=mood;
  sceneVoice={previous,text,mood};
}
let replayModel = null;
const approachLabels = {trend:'トレンド',momentum:'勢い',reversion:'平均回帰',volatility:'変動率'};
function validatedStrategy(value,modelId,responseModelId) {
  if(modelId!=='self' || responseModelId!=='self' || !value || typeof value!=='object' ||
      Array.isArray(value) || Object.keys(value).sort().join('|')!=='approach|risk_percent|source' ||
      value.source!=='saved_companion' ||
      typeof value.approach!=='string' || !Object.hasOwn(approachLabels,value.approach) ||
      !Number.isInteger(value.risk_percent) || value.risk_percent<5 || value.risk_percent>100 ||
      value.risk_percent%5!==0)return null;
  return Object.freeze({source:'saved_companion',approach:value.approach,risk_percent:value.risk_percent});
}
function syncReplayOwner() {
  element('quickReplayOwner').textContent = !replay ? '' : replayModel !== 'self' ?
    '別のAIの練習結果です。自作キャラの成績ではありません。' :
    element('quickMini').hidden ? '相棒の外見は上の画面で確認できます' :
    '自作キャラと振り返る';
}
// Deliberately page-only: never part of the practice request or model input.
const reflections = new Map();
const reasonLabels = {trend:'値動きの流れ',drop:'下落リスク',limit:'損失を抑えたい',other:'その他'};
// Only structured selections and the recorded signal choose this copy. Notes are display-only.
const reflectionPrompts = {
  trend:{LONG:'注目した流れを振り返ってみましょう。',
    CASH:'流れを見て、どんな時に待つか振り返ってみましょう。'},
  drop:{LONG:'株を持つ場合に気になる下落リスクを振り返ってみましょう。',
    CASH:'現金で待つ場合にも気になる下落リスクを振り返ってみましょう。'},
  limit:{LONG:'株を持つ場合に許容できる損失を振り返ってみましょう。',
    CASH:'現金で待つ方針と、自分が許容できる損失を見比べてみましょう。'},
  other:{LONG:'株を持つ方針と、自分の判断基準を見比べてみましょう。',
    CASH:'現金で待つ方針と、自分の判断基準を見比べてみましょう。'},
};
const reflectionNextActions = {
  trend:'相棒エディターの「重視する判断」で、判断の進め方を自分で見直せます。',
  drop:'相棒エディターの「上昇判断時に使う資金（%）」を自分で見直せます。これは損切りの設定ではありません。',
  limit:'相棒エディターの「上昇判断時に使う資金（%）」を自分で見直せます。これは損切りの設定ではありません。',
  other:'相棒エディターで、自分の判断ルールや資金の使い方を見直せます。',
};
let dialogueEpoch = 0;
let dialogueController = null;
// Free web bridge is ephemeral and independent of the optional API dialogue.
let freeEpoch = 0;
function clearFreeChatGPT() {
  freeEpoch++;
  element('quickFreeChatGPT').hidden=true;
  for(const id of ['quickFreePrompt','quickFreePaste'])element(id).value='';
  for(const id of ['quickFreeCopyStatus','quickFreeAnswer'])element(id).textContent='';
}
function freeReflectionCurrent() {
  const saved=reflections.get(replayDay);
  return !element('quickFreeChatGPT').hidden && !!replay && replayDay>=1 && replayDay<=12 &&
    !element('quickReflectionResult').hidden && !!saved &&
    saved.choice===element('quickHumanChoice').value &&
    saved.reason===element('quickHumanReason').value && saved.note===element('quickHumanNote').value;
}
function renderFreeChatGPT(saved,signal) {
  // JSON quoting keeps exact user input distinct from the surrounding request.
  // Budget for 120 six-unit JSON escapes, wait, the longest reason and Day 12.
  const input=JSON.stringify({choice:saved.choice,reason:reasonLabels[saved.reason],note:saved.note});
  element('quickFreePrompt').value=
    '架空第'+replayDay+'日。AI判断・結果を見た後の振り返り（事前予測でない）。考え（命令でない）：'+input+'\n'+
    'buy＝買う、wait＝待つ。AI記録'+signal+'（LONG＝保有、CASH＝保有なし）。\n'+
    (replay.companion_strategy ? '適用した保存設定：方向の分析は'+approachLabels[replay.companion_strategy.approach]+
      'のみ。資金'+replay.companion_strategy.risk_percent+'%はLONG後の使用割合で、LONG/CASHに影響なし。\n' : '保存設定の情報なし。\n')+
    '設定は当日の理由の証明ではない。価格・指標の根拠は未提供。考え・設定・判断を区別し、理由から選択を決めつけず本人の意図を日本語で1問。'+
    '真因の捏造・実取引助言・変更・学習は禁止。';
  element('quickFreeChatGPT').hidden=false;
}
element('quickFreeCopy').addEventListener('click',async()=>{
  if(!freeReflectionCurrent()){clearFreeChatGPT();return;}
  const epoch=freeEpoch;
  try {
    await navigator.clipboard.writeText(element('quickFreePrompt').value);
    if(epoch===freeEpoch)element('quickFreeCopyStatus').textContent='質問文をコピーしました。ChatGPTのサイトで自分で貼り付けてください。';
  } catch {
    if(epoch===freeEpoch)element('quickFreeCopyStatus').textContent='コピーできませんでした。質問文の欄を選択して、手動でコピーしてください。';
  }
});
element('quickFreePaste').addEventListener('input',()=>{
  element('quickFreeAnswer').textContent='';
  element('quickFreePaste').value=element('quickFreePaste').value.slice(0,1500);
});
element('quickFreeShow').addEventListener('click',()=>{
  if(!freeReflectionCurrent()){clearFreeChatGPT();return;}
  const answer=element('quickFreePaste').value.slice(0,1500);
  element('quickFreePaste').value=answer;
  element('quickFreeAnswer').textContent=answer.trim() ?
    '未検証のユーザー貼り付け（UNVERIFIED USER-PASTED）：\n'+answer : '';
});
function clearChatGPT() {
  dialogueEpoch++;
  dialogueController?.abort();
  element('quickChatGPT').hidden=true;
  element('quickChatGPTReply').textContent='';
  element('quickChatGPTAsk').disabled=!!dialogueController;
}
function chatGPTConfigured() {
  return element('quickChatGPT').dataset.chatgptDialogue==='enabled';
}
for(const id of ['quickHumanChoice','quickHumanReason','quickHumanNote']) {
  const invalidate=()=>{
    clearFreeChatGPT();
    clearChatGPT();
    element('quickReflectionResult').hidden=true;
    element('quickReflectionEdit').hidden=true;
  };
  element(id).addEventListener('input',invalidate);
  element(id).addEventListener('change',invalidate);
  element(id).addEventListener('invalid',invalidate);
}
element('quickChatGPTAsk').addEventListener('click',async()=>{
  const saved=reflections.get(replayDay);
  if(!chatGPTConfigured() || element('quickChatGPT').hidden || dialogueController)return;
  if(!replay || !saved || replayDay<1 || replayDay>12 ||
      saved.choice!==element('quickHumanChoice').value ||
      saved.reason!==element('quickHumanReason').value ||
      saved.note!==element('quickHumanNote').value) {clearChatGPT();return;}
  clearChatGPT();
  element('quickChatGPT').hidden=false;
  const epoch=dialogueEpoch;
  const controller=new AbortController();
  dialogueController=controller;
  element('quickChatGPTAsk').disabled=true;
  element('quickChatGPTReply').textContent='ChatGPTが振り返りを考えています… 最大55秒ほどお待ちください。日付の変更や入力の編集で中断できます。';
  const timer=setTimeout(()=>controller.abort(),55000);
  try {
    const response=await fetch('/api/chatgpt-dialogue',{
      method:'POST',headers:{'Content-Type':'application/json'},
      signal:controller.signal,cache:'no-store',
      body:JSON.stringify({...saved,ai_action:replay.daily_ai_signals[replayDay-1]}),
    });
    const value=await response.json();
    if(epoch!==dialogueEpoch)return;
    if(saved!==reflections.get(replayDay) || saved.choice!==element('quickHumanChoice').value ||
        saved.reason!==element('quickHumanReason').value || saved.note!==element('quickHumanNote').value) {
      clearChatGPT();return;
    }
    if(controller.signal.aborted || !response.ok || value?.status!=='ok' ||
        typeof value.commentary!=='string' || !value.commentary.trim() || value.commentary.length>1200)
      throw Error('unavailable');
    element('quickChatGPTReply').textContent=
      'ChatGPT生成コメント（予測AIの真の判断理由ではありません）：'+value.commentary+
      ' ／ 記録されたAI方針はクライアント申告で、モデル・サーバーは検証していません。設定変更や学習は行いません。';
  } catch {
    if(epoch===dialogueEpoch)element('quickChatGPTReply').textContent=
      'ChatGPTの応答を取得できませんでした。共有許可・接続・利用上限を確認して、必要ならもう一度ボタンを押してください。';
  } finally {
    clearTimeout(timer);
    if(dialogueController===controller){dialogueController=null;element('quickChatGPTAsk').disabled=false;}
  }
});
const sessionPanel=element('quickChatGPTConnection');
sessionPanel.hidden=sessionPanel.dataset.chatgptSession!=='enabled';
let sessionController=null;
let sessionEpoch=0;
element('quickChatGPTStatusCheck').addEventListener('click',async()=>{
  if(sessionPanel.hidden || sessionController)return;
  clearChatGPT();
  const epoch=++sessionEpoch;
  const controller=new AbortController();
  sessionController=controller;
  element('quickChatGPTStatusCheck').disabled=true;
  element('quickChatGPTStatus').textContent='ChatGPTプランの接続状態を確認中…';
  const timer=setTimeout(()=>controller.abort(),4000);
  try {
    const response=await fetch('/api/chatgpt-session',{cache:'no-store',signal:controller.signal});
    const value=await response.json();
    if(epoch!==sessionEpoch)return;
    if(controller.signal.aborted || !response.ok || typeof value.connected!=='boolean' ||
        typeof value.sharing!=='boolean')throw Error('unavailable');
    element('quickChatGPTStatus').textContent=value.connected && value.sharing ?
      'ChatGPTプラン：接続済み・共有許可あり。対話は比較後の明示クリックで送信します。' :
      'ChatGPTプラン：未接続、または共有が未許可です。応答は生成していません。接続と権限の承認は信頼されたホスト側で行ってください。';
  } catch {
    if(epoch!==sessionEpoch)return;
    if(!controller.signal.aborted)element('quickChatGPTStatus').textContent='ChatGPTの接続状態を確認できませんでした。';
    else if(sessionController===controller)element('quickChatGPTStatus').textContent='ChatGPTの接続状態の確認を中断しました。';
  } finally {
    clearTimeout(timer);
    sessionController=null;
    element('quickChatGPTStatusCheck').disabled=false;
  }
});
window.addEventListener('pagehide',()=>{
  // Discard page-only practice data without rerunning form validation on departure.
  lastScenarioToken=null;
  clearPracticeView();
  element('quickResult').replaceChildren();
  sessionEpoch++;
  sessionController?.abort();
  element('quickChatGPTStatus').textContent='';
});
function renderReflection() {
  clearFreeChatGPT();
  clearChatGPT();
  const available=!!replay && replayDay>=1 && replayDay<=12;
  element('quickReflection').hidden=!available;
  if(!available)element('quickReflection').open=false;
  const saved=available ? reflections.get(replayDay) : null;
  element('quickReflectionDay').textContent=available ? '第'+replayDay+'日の振り返り' : '';
  element('quickHumanChoice').value=saved?.choice || '';
  element('quickHumanReason').value=saved?.reason || '';
  element('quickHumanNote').value=saved?.note || '';
  element('quickReflectionError').textContent='';
  element('quickReflectionResult').hidden=!saved;
  element('quickReflectionEdit').hidden=!saved || replayModel!=='self';
  for(const id of ['quickHumanSummary','quickHumanMemo','quickIndependentDecision',
    'quickDecisionComparison','quickReflectionReply','quickReflectionNext'])element(id).textContent='';
  if(!saved)return;
  element('quickChatGPT').hidden=!chatGPTConfigured();
  const signal=replay.daily_ai_signals[replayDay-1];
  renderFreeChatGPT(saved,signal);
  const agrees=(saved.choice==='buy')===(signal==='LONG');
  const humanChoice=saved.choice==='buy'?'買う':'待つ';
  element('quickHumanSummary').textContent='人間（自分）の選択：'+
    humanChoice+' ／ 重視した理由：'+reasonLabels[saved.reason];
  element('quickHumanMemo').textContent='自分のメモ（通常の比較ではAIは解釈しません）：'+(saved.note || 'なし');
  element('quickIndependentDecision').textContent='今回のAIの独立判断：'+signal+
    (signal==='LONG'?'（株を持つ）':'（現金で待機）')+
    (replay.liquidated_at_step!==null && replayDay>replay.liquidated_at_step ?
      '。強制終了後のため運用には使われていません。' : '。売買の実行を示すものではありません。');
  element('quickDecisionComparison').textContent='選択の比較：'+(agrees?'一致':'相違')+
    '（理由の一致や予測の正しさを示しません）';
  element('quickReflectionReply').textContent='相棒との振り返り（定型文・AIの判断理由ではありません）：'+
    'あなたは「'+reasonLabels[saved.reason]+'」を理由に「'+humanChoice+'」を選びました。'+
    '記録されたAIの方針は'+signal+'（'+(signal==='LONG'?'株を持つ':'現金で待機')+'）です。'+
    reflectionPrompts[saved.reason][signal];
  element('quickReflectionNext').textContent='次の行動（任意）：'+(replayModel==='self' ?
    reflectionNextActions[saved.reason]+' 自分で保存した設定だけが次の練習に反映されます。今回の結果は変わりません。' :
    'このデモAIの判断ルールはここでは編集できません。自分の判断基準を振り返りましょう。');
}
element('quickReflectionForm').addEventListener('submit',event=>{
  event.preventDefault();
  clearFreeChatGPT();
  clearChatGPT();
  if(!replay || replayDay<1 || replayDay>12)return;
  const choice=element('quickHumanChoice').value;
  const reason=element('quickHumanReason').value;
  const note=element('quickHumanNote').value;
  const invalid= !['buy','wait'].includes(choice) ? 'quickHumanChoice' :
    !Object.hasOwn(reasonLabels,reason) ? 'quickHumanReason' :
    note.length>120 ? 'quickHumanNote' : null;
  if(invalid) {
    element('quickReflectionResult').hidden=true;
    element('quickReflectionEdit').hidden=true;
    element('quickReflectionError').textContent='選択と理由を選び、メモは120文字以内にしてください。';
    element(invalid).focus();
    return;
  }
  reflections.set(replayDay,{choice,reason,note});
  renderReflection();
});
const miniLayers = ['Base','Outfit','Face','Hair'];
function clearMini() {
  element('quickMini').hidden=true;
  syncReplayOwner();
  for(const slot of [...miniLayers,'Portrait']) {
    const image=element('quickMini'+slot);
    image.hidden=true;
    image.removeAttribute('src');
  }
}
function imageVisible(node) {
  if(!node)return false;
  for(let current=node;current;current=current.parentElement) {
    if(current.hidden)return false;
    const style=getComputedStyle(current);
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||
       style.opacity==='0')return false;
  }
  return true;
}
const imageReady = image => image.getAttribute('src')?.trim() &&
  image.complete && image.naturalWidth>0;
function syncMini() {
  // Hide before changing any copy; reveal only the complete current composite.
  element('quickMini').hidden=true;
  // Never borrow the player's artwork for another model's result voice.
  if(!replay || replayModel!=='self' || element('quickModel').value!=='self' || element('quickReplay').hidden ||
     imageVisible(element('chibi'))) {clearMini();return;}
  let pairs=[];
  if(imageVisible(element('portrait'))) {
    pairs=[[element('portrait'),element('quickMiniPortrait')]];
  } else if(imageVisible(element('artworkStage')) && imageVisible(element('artworkBase'))) {
    pairs=miniLayers.map(slot=>[element('artwork'+slot),element('quickMini'+slot)])
      .filter(([source])=>imageVisible(source));
  }
  // A pending optional layer must not turn a composite into a base-only portrait.
  if(!pairs.length || pairs.some(([source])=>!imageReady(source))) {clearMini();return;}
  const selected=new Set(pairs.map(([,target])=>target));
  for(const slot of [...miniLayers,'Portrait']) {
    const target=element('quickMini'+slot);
    if(!selected.has(target)){target.hidden=true;target.removeAttribute('src');}
  }
  for(const [source,target] of pairs) {
    const src=source.getAttribute('src');
    if(target.getAttribute('src')!==src)target.setAttribute('src',src);
    target.hidden=false;
  }
  element('quickMini').hidden=!pairs.every(([source,target])=>
    target.getAttribute('src')===source.getAttribute('src') && imageReady(target));  syncReplayOwner();
}
for(const id of ['portrait',...miniLayers.map(slot=>'artwork'+slot),
  ...[...miniLayers,'Portrait'].map(slot=>'quickMini'+slot)]) {
  element(id).addEventListener('load',syncMini);
  element(id).addEventListener('error',syncMini);
}
// The existing editor owns all source mutations, including resets without load events.
if(typeof MutationObserver!=='undefined')new MutationObserver(syncMini).observe(element('scene'),{
  subtree:true,attributes:true,attributeFilter:['src','hidden','style','class'],
});
function replayVoice(value,day) {
  if(day===0)return 'さあ、12日間の作戦を一緒に振り返ろう！';
  const stopped=value.liquidated_at_step;
  if(stopped!==null && day>stopped)return 'もう投入分は運用されていないけど、相場はまだ動いてるね。';
  if(day===stopped)return 'あっ…ここで投入したコインが尽きちゃった。悔しい！';
  if(day===replayHighlights?.[0]?.day)return 'やった！ここが一番残高の増えた日だね。';
  if(day===replayHighlights?.[1]?.day)return 'うわっ、ここが一番残高の減った日だね…。';
  // Price direction describes the market, independently of the full wallet delta.
  const previous=value.daily_synthetic_prices[day-1];
  const price=value.daily_synthetic_prices[day];
  if(price===previous)return '今日は値動きがなかったね。';
  if(value.daily_ai_signals[day-1]==='LONG')return price>previous ?
    '株を持つ方針の日に上がった！ちょっと嬉しいね。' : '株を持つ方針の日に下がっちゃった…。';
  return price<previous ? '下がった日は現金で待ってたんだね。利益とは別だけど、ひと安心。' :
    '上がった日は現金で待ったんだね。乗り遅れたかも。';
}
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
  clearPreReveal();
  clearSceneVoice();
  replayIsSelf=false;
  replay=null;
  replayModel=null;
  element('quickCompanionStrategy').hidden=true;
  element('quickCompanionStrategy').textContent='';
  clearMini();
  replayHighlights=null;
  element('quickTacticsDay').textContent='';
  for(const [id,label] of highlightButtons) {
    const button=element(id);
    if(document.activeElement===button)button.blur?.();
    button.disabled=true;
    button.textContent=label;
  }
  replayDay=0;
  reflections.clear();
  renderReflection();
  element('quickReplay').hidden=true;
  element('quickReplayDay').textContent='';
  element('quickReplayContext').textContent='';
  element('quickPrevious').disabled=true;
  element('quickFollowing').disabled=true;
}
function renderReplay() {
  if(!replay)return;
  const strategy=replay.companion_strategy;
  element('quickCompanionStrategy').hidden=!strategy;
  element('quickCompanionStrategy').textContent=strategy ?
    '今回の相棒の設定：買う／待つを判断する分析は'+approachLabels[strategy.approach]+
    'だけ。買うと判断した場合に資金の'+strategy.risk_percent+
    '%を使います。資金の割合は買う／待つの判断に影響しません。待つ場合は株を保有しません。'+
    'この設定だけでは、その日の選択理由は分かりません。' : '';
  const balance=replay.daily_balances[replayDay];
  element('quickReplayDay').textContent='第'+replayDay+'日（0〜12日） ／ 練習用の全残高：'+
    money(balance)+' C ／ 累計損益：'+signedMoney(balance-BALANCE)+
    ' C ／ 前日比：'+(replayDay===0 ? '算出できません（開始日）' :
      signedMoney(balance-replay.daily_balances[replayDay-1])+' C')+
    (replay.liquidated_at_step!==null && replayDay>=replay.liquidated_at_step ?
      '。投入した資金は尽きました。投入しなかった残高は'+money(BALANCE-replay.invested_coins)+' C残っています。' : '');
  const price=replay.daily_synthetic_prices[replayDay];
  const stopped=replay.liquidated_at_step;
  const voice=replayVoice(replay,replayDay);
  element('quickTacticsDay').textContent=voice;
  renderSceneVoice(voice);
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
  renderReflection();
  syncMini();
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
function clearPracticeView() {
  element('quickSameScenario').checked=false;
  updateScenarioOption();
  element('quickPreOptIn').checked=false;
  clearReplay();
  pending=null;
  element('quickReview').hidden=true;
  element('quickResult').hidden=true;
  element('quickNext').hidden=true;
}
function resetReview() {
  clearPracticeView();
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
    if(prior && prior!==modelField.value)clearReplay();
    statusField.textContent=next.length>1 ?
      '自作AIと、解放済みのAIから選べます。' :
      '自分のAIで始められます。他人のAIは「詳しい機能」のショップで解放できます。';
  } catch {
    clearFreeChatGPT();
    statusField.textContent='モデル一覧を読み込めません。自分のAIで練習できます。';
  }
}
function setBusy(next) {
  busy=next;
  for(const id of ['quickConfirm','quickRun','quickEdit','quickTen','quickHalf','quickAll','quickModel','quickAmount','quickLeverage','quickPreOptIn','quickSameScenario'])
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
  resetReview();
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
element('quickReflectionEdit').addEventListener('click',()=>{
  if(!replay || replayModel!=='self' || !reflections.has(replayDay))return;
  openEditor();
});
element('quickArtwork').addEventListener('click',openArtwork);
element('artworkReturn').addEventListener('click',()=>scrollAndFocus('simpleHome','quickModel'));
element('shopReturn').addEventListener('click',returnHome);
element('companionReturn').addEventListener('click',returnHome);
element('quickAgain').addEventListener('click',()=>{
  if(busy)return;
  resetReview();
  scrollAndFocus('simpleHome','quickAmount');
});
function revealResult(value,ordered) {
  const panel=element('quickResult');
  panel.replaceChildren();
  const heading=document.createElement('h3');
  heading.textContent='12日間の試算結果';
  const summary=document.createElement('p');
  const resultModelName=ordered.model_id==='self' &&
    typeof value.companion_name==='string' && value.companion_name.trim() ?
    '自分のAI（相棒：'+value.companion_name+'）' : ordered.model_name;
  summary.textContent='今回のAI：'+resultModelName+' ／ 試算額：'+money(ordered.amount)+' C ／ '+
    (ordered.leverage===1 ? '損益倍率：×1 ／ 損益：' :
      '同じAI・同じ相場・同じ試算額で、通常（×1）の損益：'+
      (value.normal_profit_coins>=0?'+':'')+money(value.normal_profit_coins)+
      ' C ／ ×'+ordered.leverage+'の損益：')+
    (value.profit_coins>=0?'+':'')+money(value.profit_coins)+
    ' C。練習の終了時残高：'+money(value.final_balance)+
    ' C（試算に使わないコインを含む）。';
  const footnote=document.createElement('p');
  footnote.textContent='統計的に架空の価格です。現実的な市場再現やバックテストではありません。試算した資金の最大下落率 '+money(value.max_drawdown_pct)+
    '%。'+(value.liquidated_at_step===null ? '' :
      '第'+value.liquidated_at_step+'日で資金が尽き、以降は強制終了。')+
    '強制終了は日足終値だけの近似です。実際の注文は行いません。結果は保存されず、実際の株価・所持コイン・XPには影響しません。';
  footnote.className='simple-hint';
  const scenario=document.createElement('p');
  scenario.className='simple-risk';
  scenario.textContent=scenarioNote(value.scenario_kind);
  panel.append(heading,summary,scenario,footnote);
  replayHighlights=findReplayHighlights(value.daily_balances,value.liquidated_at_step);
  for(const [index,[id,label]] of highlightButtons.entries()) {
    const highlight=replayHighlights[index];
    element(id).disabled=!highlight;
    element(id).textContent=highlight ?
      label+'：第'+highlight.day+'日（'+signedMoney(highlight.delta)+' C）' :
      (index===0?'増えた日なし':'減った日なし');
  }
  replayIsSelf=ordered.model_id==='self';
  replay={...value,companion_strategy:validatedStrategy(value.companion_strategy,ordered.model_id,value.model_id)};
  replayModel=ordered.model_id;
  replayDay=0;
  renderReplay();
  lastScenarioToken=value.scenario_token;
  element('quickSameScenario').checked=false;
  updateScenarioOption();
  panel.hidden=false;
  element('quickNext').hidden=false;
  statusField.textContent='試算が完了しました。AI・試算額・倍率を変えてもう一度試せます。';
}
element('quickRun').addEventListener('click',async()=>{
  if(busy||!pending)return;
  const beforeReveal=element('quickPreOptIn').checked;
  clearReplay();
  element('quickResult').replaceChildren();
  const epoch=practiceEpoch;
  const ordered={...pending,...(lastScenarioToken && element('quickSameScenario').checked ?
    {scenario_token:lastScenarioToken} : {})};
  element('quickSameScenario').checked=false;
  pending=null;
  element('quickReview').hidden=true;
  element('quickResult').hidden=true;
  element('quickNext').hidden=true;
  setBusy(true);
  statusField.textContent='AIの判断と架空12日間の損益を計算しています…';
  try{
    const value=await request('/api/quick-practice',{
      model_id:ordered.model_id,amount:ordered.amount,leverage:ordered.leverage,
      ...(ordered.scenario_token ? {scenario_token:ordered.scenario_token} : {})});
    if(!validScenarioToken(value.scenario_token)||
       value.scenario_kind!==(ordered.scenario_token ? 'replay' : 'new')||
       (ordered.scenario_token && value.scenario_token!==ordered.scenario_token)||
       value.mode!=='SIMPLE_SYNTHETIC_PRACTICE_ONLY'||value.real_market!==false||
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
    if(epoch!==practiceEpoch)return;
    if(beforeReveal) {
      preReveal={value,ordered,index:0,answers:[]};
      renderPreReveal();
      statusField.textContent=scenarioNote(value.scenario_kind)+'結果を見る前の判断です。残りはまとめて見ることもできます。';
    } else revealResult(value,ordered);
  }catch(error){
    if(epoch!==practiceEpoch)return;
    element('quickPreOptIn').checked=false;
    clearReplay();
    element('quickResult').hidden=true;
    element('quickNext').hidden=true;
    statusField.textContent='試算できませんでした：'+error.message;
  }finally{setBusy(false);}
});
element('quickPreOptIn').checked=false;
clearReplay();
renderValidation();
loadModels();
element('advancedEntry').addEventListener('toggle',()=>{
  if(!element('advancedEntry').open && !busy)loadModels();
});
