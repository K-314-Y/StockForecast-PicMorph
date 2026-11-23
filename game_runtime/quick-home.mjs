/** Beginner-only flow. Uses 12 synthetic days; never places real orders. */
const element = id => document.getElementById(id);
const BALANCE = 10000;
const money = value => Number(value).toLocaleString('ja-JP',{maximumFractionDigits:2});
let practiceEpoch = 0;
let preReveal = null;
let lastScenarioToken = null;
const validScenarioToken = token => typeof token==='string' && token.length===19 && /^v1_[0-9a-f]{16}$/.test(token);
const validFingerprint = value => typeof value==='string' && value.length===64 && /^[a-f0-9]{64}$/.test(value);
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
const preReactions = {
  anticipation:['💭','選択を見守り中'],
  buy:['🌱','「買う」を選んだね'],
  wait:['🍃','「待つ」を選んだね'],
};
function renderPreCue(reaction) {
  const cue=element('quickPreCue');
  if(!reaction) {
    cue.hidden=true;
    delete cue.dataset.reaction;
    element('quickPreCueIcon').textContent='';
    element('quickPreCueText').textContent='';
    return;
  }
  const [icon,text]=preReactions[reaction];
  cue.dataset.reaction=reaction;
  element('quickPreCueIcon').textContent=icon;
  element('quickPreCueText').textContent=(preReveal.hasCompanion?'相棒：':'冒険ガイド：')+text;
  cue.hidden=false;
}
function renderPreBuddyLine(agrees) {
  const {hasCompanion,index}=preReveal;
  // Authored copy: no prices, signals, profit or model-generated explanations.
  const speaker=hasCompanion?'相棒（定型文）：':'冒険ガイド（定型文）：';
  const line=agrees===undefined ? preBuddyPrompts[index] :
    'あなたの選択は、今回使ったAIの判断'+(agrees?'と同じだったね。':'とは違ったね。');
  element('quickPreBuddyLine').textContent=speaker+line;
}
function clearPreReveal() {
  practiceEpoch++;
  preReveal=null;
  element('quickPreReveal').hidden=true;
  renderPreCue(null);
  element('quickPreSummary').hidden=true;
  for(const id of ['quickPreBuddyLine','quickPreSnapshot','quickPreOutcome','quickPreSummary'])element(id).textContent='';
  for(const id of ['quickPreBuy','quickPreWait','quickPreNext','quickPreSkip'])element(id).disabled=true;
  element('quickPreNext').textContent='次へ';
}
function renderPreReveal() {
  const {value,index}=preReveal;
  const day=checkpoints[index];
  renderPreBuddyLine();
  renderPreCue('anticipation');
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
  renderPreCue(null);
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
    renderPreCue(choice);
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
let replayZipId = null;
// Module-local ownership: advanced scenes must survive quick-practice cleanup.
let sceneVoice = null;
function clearSceneVoice() {
  if(sceneVoice && element('speech').textContent===sceneVoice.text &&
      element('scene').dataset.mood===sceneVoice.mood) {
    element('speech').textContent=sceneVoice.previous.text;
    const state=element('scene').dataset;
    if(sceneVoice.previous.mood===undefined)delete state.mood;
    else state.mood=sceneVoice.previous.mood;
    if(sceneVoice.previous.expressionOtherModel===undefined)delete state.expressionOtherModel;
    else state.expressionOtherModel=sceneVoice.previous.expressionOtherModel;
  }
  sceneVoice=null;
}
function renderSceneVoice(text) {
  if(!replayIsSelf)return;
  const scene=element('scene'),speech=element('speech');
  // If another module took over, its current scene becomes the restore point.
  if(sceneVoice && (speech.textContent!==sceneVoice.text || scene.dataset.mood!==sceneVoice.mood))
    sceneVoice=null;
  const previous=sceneVoice?.previous || {text:speech.textContent,mood:scene.dataset.mood,
    expressionOtherModel:scene.dataset.expressionOtherModel};
  const delta=replayDay===0?0:replay.daily_balances[replayDay]-replay.daily_balances[replayDay-1];
  const mood=replay.liquidated_at_step!==null && replayDay>=replay.liquidated_at_step ?
    'cautious' : replayDay===0?'ready':delta<0?'cautious':delta>0?'happy':'thinking';
  speech.textContent=text;
  delete scene.dataset.expressionOtherModel;
  scene.dataset.mood=mood;
  sceneVoice={previous,text,mood};
}
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
  const imported=zipCharacters.find(item=>item.id===replayZipId);
  element('quickReplayOwner').textContent = !replay ? '' : imported ?
    '登録したZIPキャラ「'+imported.name+'」専用AIの架空練習結果です（実相場の成績ではありません）。' :
    !replayIsSelf ? '別のAIの練習結果です。自作キャラの成績ではありません。' :
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
  element('quickChatGPTAsk').disabled=!!dialogueController || multiComparisonRunning();
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
  if(!chatGPTConfigured() || element('quickChatGPT').hidden || dialogueController || multiComparisonRunning())return;
  if(!replay || !saved || replayDay<1 || replayDay>12 ||
      saved.choice!==element('quickHumanChoice').value ||
      saved.reason!==element('quickHumanReason').value ||
      saved.note!==element('quickHumanNote').value) {clearChatGPT();return;}
  clearChatGPT();
  element('quickChatGPT').hidden=false;
  const epoch=dialogueEpoch;
  const controller=new AbortController();
  dialogueController=controller;
  updateCompareControls();
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
    if(dialogueController===controller){dialogueController=null;updateCompareControls();}
  }
});
const sessionPanel=element('quickChatGPTConnection');
sessionPanel.hidden=sessionPanel.dataset.chatgptSession!=='enabled';
let sessionController=null;
let sessionEpoch=0;
element('quickChatGPTStatusCheck').addEventListener('click',async()=>{
  if(sessionPanel.hidden || sessionController || multiComparisonRunning())return;
  clearChatGPT();
  const epoch=++sessionEpoch;
  const controller=new AbortController();
  sessionController=controller;
  updateCompareControls();
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
    updateCompareControls();
  }
});
window.addEventListener('pagehide',()=>{
  // Discard page-only practice data without rerunning form validation on departure.
  modelListEpoch++;
  lastScenarioToken=null;
  clearPracticeView();
  for(const [url,timer] of comparisonDownloadUrls) {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
  comparisonDownloadUrls.clear();
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
  element('quickReflectionEdit').hidden=!saved || !replayIsSelf;
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
  element('quickReflectionNext').textContent='次の行動（任意）：'+(replayIsSelf ?
    reflectionNextActions[saved.reason]+' 自分で保存した設定だけが次の練習に反映されます。今回の結果は変わりません。' :
    (replayZipId ? 'このZIP専用AIの判断ルールは現在の画面では編集できません。' :
      'このデモAIの判断ルールはここでは編集できません。')+
      '自分の判断基準を振り返りましょう。');
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
  // A ZIP character uses its own saved portrait, never the original self artwork.
  const imported=zipCharacters.find(item=>item.id===replayZipId);
  if(imported && element('quickModel').value===replayZipId && !element('quickReplay').hidden) {
    for(const slot of miniLayers) {
      const part=element('quickMini'+slot);
      part.hidden=true;part.removeAttribute('src');
    }
    const target=element('quickMiniPortrait');
    if(target.getAttribute('src')!==imported.image_url)target.src=imported.image_url;
    target.hidden=false;
    element('quickMini').hidden=!imageReady(target);
    syncReplayOwner();
    return;
  }
  // Never borrow the player's artwork for another model's result voice.
  if(!replay || !replayIsSelf || element('quickModel').value!=='self' || element('quickReplay').hidden ||
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
  const policy=value.daily_ai_signals[day-1]==='LONG'?'株を持つ':'現金で待機';
  return '方針は「'+policy+'」。架空の価格は前日より'+(price>previous?'上がった':'下がった')+'ね。';
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
  clearCompare();
  clearPreReveal();
  clearSceneVoice();
  replayIsSelf=false;
  replayZipId=null;
  replay=null;
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
const linkedModelIds=new URLSearchParams(location.search).getAll('model');
const linkedModelId=linkedModelIds[0];
let initialZipId=linkedModelIds.length===1 && linkedModelId.length===36 &&
  /^zip_[a-f0-9]{32}$/.test(linkedModelId) ? linkedModelId : null;
let zipCharacters = [];
function showLinkedZip() {
  const record=zipCharacters.find(item=>item.id===modelField.value);
  const panel=element('quickZipLinked'),portrait=element('quickZipPortrait');
  const editLink=element('quickZipEditLink');
  panel.hidden=!record;
  panel.style.display=record?'flex':'none';
  editLink.hidden=!record;
  if(record) {
    if(portrait.getAttribute('src')!==record.image_url)portrait.src=record.image_url;
    const editUrl=new URL('/parts-lab/preview.html',window.location.origin);
    editUrl.searchParams.set('edit',record.id);
    editLink.setAttribute('href',editUrl.href);
  } else {
    portrait.removeAttribute('src');
    editLink.removeAttribute('href');
  }
  const accessoryLabel={star:'星',glasses:'眼鏡',ribbon:'リボン',none:'なし'};
  const analysisLabel={
    bollinger_breakout:'ボリンジャーバンドで急な上昇を検出',
    rsi_oversold:'RSIで売られすぎを検出',
    macd_momentum:'MACDで上昇の勢いを検出',
    moving_average_trend:'移動平均で価格の流れを確認',
  };
  const analysis=record?.accessory_analysis;
  const equipped=Array.isArray(analysis?.equipped) ? analysis.equipped : null;
  const primary=equipped ? equipped.map(({name,method})=>name+'（'+analysisLabel[method]+'）').join('・') :
    analysisLabel[analysis?.method];
  const weights=record?.model?.plugin_weights;
  const appearance=record?.appearance;
  const traits=!equipped && appearance && record.model_origin==='appearance_features' ?
    'アクセサリー：'+(accessoryLabel[appearance.look?.accessory]??'未設定')+' ／ ' :
    '';
  const strategy=weights&&Number.isFinite(record.model.risk_fraction) ?
    (primary?'補助分析：':'分析比率：')+'流れ'+weights.trend+'%・勢い'+weights.momentum+
    '%・反転'+weights.reversion+'%・変動'+weights.volatility+
    '% ／ 資金使用率'+Math.round(record.model.risk_fraction*100)+'%。' : '';
  element('quickZipDetails').textContent=record ?
    record.name+' ／ '+traits+(primary?'主な分析：'+primary+' ／ ':'')+
    (equipped?'装備名だけでは外見は変わりません。重ね絵を付けた場合は画像に反映されます。':'')+strategy+
    '専用AI '+record.ai_id.slice(0,12)+'…。'+
    (appearance ? '外見の特徴から予測設定を作成。' : '以前の手動設定。')+
    '未学習・架空練習専用。':'';
}
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
  if(focusId==='modelShopTitle')
    target.setAttribute('tabindex','-1');
  target.focus?.({preventScroll:true});
}
function openShop() {
  element('advancedEntry').open=true;
  scrollAndFocus('modelShopSection','modelShopTitle');
}
function openEditor() {
  element('advancedEntry').open=true;
  element('appearanceStudio').open=false;
  element('predictionStudio').open=true;
  element('companionControls').open=true;
  scrollAndFocus('predictionStudio','companionEditorTitle');
}
function openArtwork() {
  element('advancedEntry').open=true;
  element('predictionStudio').open=false;
  element('appearanceStudio').open=true;
  element('lookControls').open=true;
  element('artworkControls').open=true;
  scrollAndFocus('appearanceStudio','appearanceStudioTitle');
}
if(typeof HTMLDetailsElement!=='undefined' && !('name' in HTMLDetailsElement.prototype)) {
  const appearance=element('appearanceStudio'),prediction=element('predictionStudio');
  appearance.addEventListener('toggle',()=>{if(appearance.open)prediction.open=false;});
  prediction.addEventListener('toggle',()=>{if(prediction.open)appearance.open=false;});
}
async function returnHome() {
  scrollAndFocus('simpleHome','quickModel');
  await loadModels();
}
async function request(url,body,signal) {
  const response=await fetch(url,body ? {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
    ...(signal ? {signal} : {}),
  }:undefined);
  const value=await response.json().catch(error=>{
    throw Object.assign(error,{status:response.status});
  });
  if(!response.ok)throw Object.assign(Error(value?.error||'サーバーの処理に失敗しました'),
    {status:response.status,code:value?.code});
  return value;
}
let modelListEpoch=0;
let compareChoices=new Map();
async function loadModels() {
  const epoch=++modelListEpoch;
  resetAccessoryFixed();
  try {
    const data=await request('/api/model-shop');
    if(epoch!==modelListEpoch)return;
    const importedWarning=!!data.imported_characters_error;
    const imported=Array.isArray(data.imported_characters)?data.imported_characters:[];
    zipCharacters=imported.filter(item=>
      typeof item?.id==='string' && item.id.length===36 &&
      /^zip_[a-f0-9]{32}$/.test(item.id) && item.ai_id===item.id &&
      typeof item.name==='string' && typeof item.model_version==='string');
    const next=[{id:'self',name:'自分のAI（未作成なら標準AI）'}];
    for(const character of zipCharacters)
      next.push({id:character.id,name:character.name+'（ZIP専用AI・未学習）'});
    for(const model of data.models || []) {
      if(model.owned===true && typeof model.id==='string' && typeof model.name==='string')
        next.push({id:model.id,name:model.name+'（解放済み）'});
    }
    const registeredIds=new Set(zipCharacters.map(({id})=>id));
    compareChoices=new Map(next.filter(({id})=>id==='self' ||
      /^demo_[a-z_]{1,40}$/.test(id) || registeredIds.has(id)).map(({id,name})=>[id,name]));
    const prior=modelField.value;
    modelField.replaceChildren();
    for(const item of next){
      const option=document.createElement('option');
      option.value=item.id;
      option.textContent=item.name;
      modelField.append(option);
    }
    // Only a successful ZIP listing can resolve the link.
    const requestedZipId=importedWarning ? null : initialZipId;
    if(!importedWarning)initialZipId=null;
    const linkedZipFound=registeredIds.has(requestedZipId);
    const preservedId=next.some(item=>item.id===prior) ? prior : 'self';
    modelField.value=linkedZipFound ? requestedZipId : preservedId;
    showLinkedZip();
    if(replay && replayZipId===modelField.value)syncMini();
    // A refreshed model may have different settings under the same ID.
    resetAccessoryControl();
    if(prior && prior!==modelField.value)clearReplay();
    if(compareBase)refreshCompareModels();
    if(requestedZipId) {
      statusField.textContent=linkedZipFound ?
        'リンク先のZIPキャラのAIを選びました。' :
        'リンク先のZIPキャラが見つかりません。練習に使うAIを選んでください。';
    } else {
      statusField.textContent=(next.length>1 ?
        '自作AIと、登録済み・解放済みのAIから選べます。' :
        '自分のAIで始められます。他人のAIは「詳しい機能」のショップで解放できます。')+
        (importedWarning ? ' ZIPキャラ一覧の読み込みには失敗しました。' : '');
    }
  } catch {
    if(epoch!==modelListEpoch)return;
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
  initialZipId=null;
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
    resetAccessoryControl();
    touched=true;
    resetReview();
  });
}
element('quickEdit').addEventListener('click',()=>{
  resetReview();
  amountField.focus();
});
amountField.addEventListener('input',()=>{resetAccessoryControl();resetReview();});
amountField.addEventListener('change',()=>resetAccessoryControl());
amountField.addEventListener('blur',()=>{touched=true;renderValidation(true);});
modelField.addEventListener('change',()=>{
  initialZipId=null;
  resetAccessoryControl();
  resetReview();
  showLinkedZip();
});
modelField.addEventListener('input',()=>{
  initialZipId=null;
  resetAccessoryControl();
});
window.addEventListener('focus',()=>{if(!busy)void loadModels();});
leverageField.addEventListener('change',()=>{resetAccessoryControl();showLeverageInfo();resetReview();});
leverageField.addEventListener('input',()=>resetAccessoryControl());
element('quickShop').addEventListener('click',openShop);
element('quickNextShop').addEventListener('click',openShop);
element('quickGrow').addEventListener('click',()=>{
  element('advancedEntry').open=true;
  scrollAndFocus('play','play');
});
element('quickCustomize').addEventListener('click',openEditor);
element('switchToPrediction').addEventListener('click',openEditor);
element('switchToAppearance').addEventListener('click',openArtwork);
element('quickReflectionEdit').addEventListener('click',()=>{
  if(!replay || !replayIsSelf || !reflections.has(replayDay))return;
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
function validPracticeResult(value,ordered) {
  return value?.mode==='SIMPLE_SYNTHETIC_PRACTICE_ONLY' &&
    value.real_market===false && value.persisted===false &&
    value.invested_coins===ordered.amount && value.leverage===ordered.leverage &&
    Array.isArray(value.daily_ai_signals) && value.daily_ai_signals.length===12 &&
    Array.from(value.daily_ai_signals).every(signal=>signal==='LONG'||signal==='CASH') &&
    Array.isArray(value.daily_synthetic_prices) && value.daily_synthetic_prices.length===13 &&
    Array.from(value.daily_synthetic_prices).every(price=>Number.isFinite(price)&&price>0&&price<=1e12) &&
    Array.isArray(value.daily_balances) && value.daily_balances.length===13 &&
    Array.from(value.daily_balances).every(balance=>
      Number.isFinite(balance)&&balance>=0&&balance<=Number.MAX_SAFE_INTEGER) &&
    value.daily_balances[0]===BALANCE && Number.isFinite(value.final_balance) &&
    Math.abs(value.daily_balances[12]-value.final_balance)<=0.01 &&
    Number.isFinite(value.profit_coins) && value.final_balance>=0 && value.profit_coins>=-ordered.amount &&
    (value.liquidated_at_step===null || (Number.isInteger(value.liquidated_at_step) &&
      value.liquidated_at_step>=1 && value.liquidated_at_step<=12));
}
function validCompareOutcome(value,modelId) {
  return value.model_id===modelId && value.order_placed===false && value.xp_awarded===false &&
    Number.isFinite(value.max_drawdown_pct) && value.max_drawdown_pct>=0 && value.max_drawdown_pct<=100;
}
function practiceModelName(value,ordered) {
  return ordered.model_id==='self' && (value.model_id===undefined || value.model_id==='self') &&
    typeof value.companion_name==='string' && value.companion_name.trim() ?
    '自分のAI（相棒：'+value.companion_name+'）' : ordered.model_name;
}

const accessoryLabels={star:'星（ボリンジャーバンド）',glasses:'眼鏡（RSI）',
  ribbon:'リボン（MACD）',none:'装備なし（移動平均トレンド）'};
const accessoryA=element('quickAccessoryA'),accessoryB=element('quickAccessoryB');
const accessoryRun=element('quickAccessoryRun'),accessoryStatus=element('quickAccessoryStatus');
const accessoryResult=element('quickAccessoryResult'),accessorySummary=element('quickAccessorySummary');
const accessoryRows=element('quickAccessoryRows');
const accessoryMultiRun=element('quickAccessoryMultiRun'),accessoryMultiStatus=element('quickAccessoryMultiStatus');
const accessoryMultiResult=element('quickAccessoryMultiResult'),accessoryMultiRows=element('quickAccessoryMultiRows');
const accessoryMultiSummary=element('quickAccessoryMultiSummary');
const accessoryFixedRun=element('quickAccessoryFixedRun'),accessoryFixedVerify=element('quickAccessoryFixedVerify');
const accessoryFixedStatus=element('quickAccessoryFixedStatus'),accessoryFixedResult=element('quickAccessoryFixedResult');
const accessoryFixedRows=element('quickAccessoryFixedRows'),accessoryFixedSummary=element('quickAccessoryFixedSummary');
const ACCESSORY_FIXED_PATH='/api/accessory-control/fixed';
const ACCESSORY_FIXED_SET='accessory-precommitted-v1';
const ACCESSORY_TRIAL_COUNT=4;
const ACCESSORY_TRIAL_TIMEOUT_MS=15_000;
let accessoryEpoch=0,accessoryController=null;
let accessoryFirst=null,accessoryMultiEpoch=0,accessoryMultiController=null;
let accessoryFixedEpoch=0,accessoryFixedController=null,accessoryFixedFirst=null;

function currentAccessoryOrder() {
  return Object.freeze({model_id:modelField.value,accessory_a:accessoryA.value,accessory_b:accessoryB.value,
    amount:validAmount(),leverage:validLeverage()});
}

function availableAccessoryModel(id) {
  return id==='self' || zipCharacters.some(zip=>zip.id===id);
}

function distinctAccessoryMethods({accessory_a,accessory_b}) {
  return Object.hasOwn(accessoryLabels,accessory_a) && Object.hasOwn(accessoryLabels,accessory_b) &&
    accessory_a!==accessory_b;
}

function updateAccessoryFixedRun() {
  const ordered=currentAccessoryOrder();
  accessoryFixedRun.disabled=!!accessoryFixedController || !availableAccessoryModel(ordered.model_id) ||
    ordered.amount===null || ordered.leverage===null || !distinctAccessoryMethods(ordered);
}

function resetAccessoryFixed() {
  accessoryFixedEpoch++;
  accessoryFixedController?.abort();
  accessoryFixedController=null;
  accessoryFixedFirst=null;
  updateAccessoryFixedRun();
  accessoryFixedVerify.hidden=true;
  accessoryFixedVerify.disabled=true;
  accessoryFixedStatus.textContent='';
  accessoryFixedResult.hidden=true;
  accessoryFixedRows.replaceChildren();
  accessoryFixedSummary.replaceChildren();
}

function clearAccessoryMultiResult() {
  accessoryMultiResult.hidden=true;
  accessoryMultiRows.replaceChildren();
  accessoryMultiSummary.replaceChildren();
}

function resetAccessoryControl() {
  accessoryEpoch++;
  accessoryController?.abort();
  accessoryController=null;
  accessoryRun.disabled=false;
  accessoryResult.hidden=true;
  accessorySummary.replaceChildren();
  accessoryRows.replaceChildren();
  accessoryStatus.textContent='';
  accessoryMultiEpoch++;
  accessoryMultiController?.abort();
  accessoryMultiController=null;
  accessoryFirst=null;
  accessoryMultiRun.hidden=true;
  accessoryMultiRun.disabled=true;
  accessoryMultiStatus.hidden=true;
  accessoryMultiStatus.textContent='';
  clearAccessoryMultiResult();
  resetAccessoryFixed();
}
for(const select of [accessoryA,accessoryB]) {
  select.addEventListener('input',resetAccessoryControl);
  select.addEventListener('change',resetAccessoryControl);
}
window.addEventListener('pagehide',resetAccessoryControl);

function validAccessoryResponse(value,ordered,fixedCaseNumber=null) {
  const validArm=(arm,accessory)=>hasComparisonKeys(arm,'accessory','model_effective_sha256',
    'daily_ai_signals','profit_coins','max_drawdown_pct','liquidated_at_step') &&
    arm.accessory===accessory && validFingerprint(arm.model_effective_sha256) &&
    Array.isArray(arm.daily_ai_signals) && arm.daily_ai_signals.length===12 &&
    Array.from(arm.daily_ai_signals).every(signal=>signal==='LONG'||signal==='CASH') &&
    validImportedOutcome({profit_coins:arm.profit_coins,max_drawdown_pct:arm.max_drawdown_pct,
      liquidated_at_step:arm.liquidated_at_step},ordered.amount) &&
    (arm.liquidated_at_step===null || (arm.profit_coins===-ordered.amount && arm.max_drawdown_pct===100));
  const fixed=fixedCaseNumber!==null;
  return hasComparisonKeys(value,'mode','real_market','persisted','order_placed','xp_awarded',
    'model_id','scenario_token','engine_source_sha256','amount','leverage','daily_synthetic_prices',
    'baseline_fingerprint','a','b',...(fixed?['scenario_set','case_number']:[])) &&
    (fixed ? value.mode==='CONTROLLED_SYNTHETIC_ACCESSORY_FIXED_V1' &&
      value.scenario_set===ACCESSORY_FIXED_SET && value.case_number===fixedCaseNumber :
      value.mode==='CONTROLLED_SYNTHETIC_ACCESSORY_ONLY') &&
    value.real_market===false && value.persisted===false && value.order_placed===false &&
    value.xp_awarded===false && value.model_id===ordered.model_id && value.amount===ordered.amount &&
    value.leverage===ordered.leverage && validScenarioToken(value.scenario_token) &&
    validFingerprint(value.engine_source_sha256) && validFingerprint(value.baseline_fingerprint) &&
    Array.isArray(value.daily_synthetic_prices) && value.daily_synthetic_prices.length===13 &&
    Array.from(value.daily_synthetic_prices).every(price=>Number.isFinite(price)&&price>0&&price<=1e12) &&
    validArm(value.a,ordered.accessory_a) && validArm(value.b,ordered.accessory_b) &&
    value.a.model_effective_sha256!==value.b.model_effective_sha256;
}

function accessoryDifferences(value) {
  return value.a.daily_ai_signals.filter((signal,index)=>signal!==value.b.daily_ai_signals[index]).length;
}

function accessoryOrderIsCurrent(ordered) {
  return ordered.model_id===modelField.value && ordered.accessory_a===accessoryA.value &&
    ordered.accessory_b===accessoryB.value && ordered.amount===validAmount() && ordered.leverage===validLeverage();
}

function renderAccessoryResult(value) {
  const arms=[value.a,value.b];
  for(const [index,arm] of arms.entries()) {
    const summary=document.createElement('li');
    summary.textContent=(index===0?'A':'B')+' '+accessoryLabels[arm.accessory]+' ／ 損益 '+
      (arm.profit_coins>0?'+':'')+money(arm.profit_coins)+' C ／ 最大下落率 '+money(arm.max_drawdown_pct)+'%'+
      (arm.liquidated_at_step===null?'':' ／ '+arm.liquidated_at_step+'日目に強制終了');
    accessorySummary.append(summary);
  }
  for(let day=1;day<=12;day++) {
    const row=document.createElement('tr');
    const date=document.createElement('th');
    date.setAttribute('scope','row');
    date.textContent=String(day);
    const price=document.createElement('td');
    price.textContent=money(value.daily_synthetic_prices[day]);
    row.append(date,price);
    for(const arm of arms) {
      const signal=document.createElement('td');
      signal.textContent=arm.daily_ai_signals[day-1]==='LONG'?'株を持つ':'現金で待つ';
      if(arm.liquidated_at_step!==null && day>arm.liquidated_at_step) {
        const note=document.createElement('small');
        note.textContent='損益に未反映';
        signal.append(note);
      }
      row.append(signal);
    }
    accessoryRows.append(row);
  }
  const differences=accessoryDifferences(value);
  const comparison=document.createElement('li');
  comparison.textContent='判断が違った日 '+differences+'/12日（強制終了後の判断も含む）。'+
    (differences===0?'この1例では判断が一致しました。手法自体の違いは残ります。':'');
  accessorySummary.append(comparison);
  accessoryResult.hidden=false;
  accessoryStatus.textContent='試算額 '+money(value.amount)+' C ／ ×'+value.leverage+
    ' ／ 架空の開始価格 '+money(value.daily_synthetic_prices[0])+'。';
}

function accessoryTrialStats(value) {
  return {aProfit:value.a.profit_coins,bProfit:value.b.profit_coins,
    aDrawdown:value.a.max_drawdown_pct,bDrawdown:value.b.max_drawdown_pct,differences:accessoryDifferences(value)};
}

function renderAccessoryTrialResults(trials,result,rows,summary) {
  const amountText=(value,unit)=>{
    const formatted=money(value);
    return (formatted==='-0'?'0':formatted)+unit;
  };
  const makeRow=(label,stats,days)=>{
    const row=document.createElement('tr');
    const header=document.createElement('th');
    header.setAttribute('scope','row');
    header.textContent=label;
    row.append(header);
    for(const [a,b,unit] of [[stats.aProfit,stats.bProfit,' C'],[stats.aDrawdown,stats.bDrawdown,'%']]) {
      const cell=document.createElement('td');
      for(const [arm,value] of [['A',a],['B',b]]) {
        const line=document.createElement('span');
        line.textContent=arm+' '+amountText(value,unit);
        cell.append(line);
      }
      row.append(cell);
    }
    const differences=document.createElement('td');
    differences.textContent=stats.differences+'/'+days+'日';
    row.append(differences);
    return row;
  };
  const total={aProfit:0,bProfit:0,aDrawdown:0,bDrawdown:0,differences:0};
  for(const trial of trials)
    for(const key of Object.keys(total))total[key]+=trial[key];
  const mean={aProfit:total.aProfit/ACCESSORY_TRIAL_COUNT,bProfit:total.bProfit/ACCESSORY_TRIAL_COUNT,
    aDrawdown:total.aDrawdown/ACCESSORY_TRIAL_COUNT,bDrawdown:total.bDrawdown/ACCESSORY_TRIAL_COUNT,
    differences:total.differences};
  rows.replaceChildren(...trials.map((trial,index)=>makeRow(String(index+1),trial,12)));
  summary.replaceChildren(makeRow('平均／合計',mean,12*ACCESSORY_TRIAL_COUNT));
  result.hidden=false;
}

async function requestAccessoryTrial(ordered,controller,path='/api/accessory-control') {
  const {signal}=controller;
  let onAbort;
  const canceled=new Promise((_,reject)=>{
    onAbort=()=>reject(Error('Accessory trial canceled'));
    signal.addEventListener('abort',onAbort,{once:true});
  });
  const timeout=setTimeout(()=>controller.abort(),ACCESSORY_TRIAL_TIMEOUT_MS);
  try {
    return await Promise.race([request(path,ordered,signal),canceled]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort',onAbort);
  }
}

accessoryRun.addEventListener('click',async event=>{
  if(!event.isTrusted || accessoryController)return;
  resetAccessoryControl();
  const ordered=currentAccessoryOrder();
  if(!availableAccessoryModel(ordered.model_id)) {
    accessoryStatus.textContent='自分のAIまたは登録済みZIPのAIを選んでください。';
    return;
  }
  if(ordered.amount===null || ordered.leverage===null) {
    accessoryStatus.textContent='試算額は1〜10,000の整数、倍率は1〜25から選んでください。';
    return;
  }
  if(!distinctAccessoryMethods(ordered)) {
    accessoryStatus.textContent='AとBで異なる分析を選んでください。';
    return;
  }
  const epoch=accessoryEpoch;
  const controller=new AbortController();
  accessoryController=controller;
  accessoryRun.disabled=true;
  accessoryStatus.textContent='実験中…';
  const isCurrent=()=>epoch===accessoryEpoch && accessoryOrderIsCurrent(ordered);
  try {
    const value=await request('/api/accessory-control',ordered,controller.signal);
    if(!isCurrent())return;
    if(!validAccessoryResponse(value,ordered))throw Error('Invalid accessory result');
    renderAccessoryResult(value);
    accessoryFirst=Object.freeze({ordered,stats:Object.freeze(accessoryTrialStats(value)),
      scenarioToken:value.scenario_token,engine:value.engine_source_sha256,baseline:value.baseline_fingerprint,
      aFingerprint:value.a.model_effective_sha256,bFingerprint:value.b.model_effective_sha256});
    accessoryMultiRun.hidden=false;
    accessoryMultiRun.disabled=false;
  } catch(error) {
    if(!isCurrent())return;
    resetAccessoryControl();
    accessoryStatus.textContent=error?.code==='PRACTICE_ENGINE_SOURCE_UNVERIFIED' ?
      '予測エンジンの計算コードを確認できません。' : error?.status===409 ?
        '実験中にモデルが変更されました。再度お試しください。' : '実験結果を確認できませんでした。';
  } finally {
    if(epoch===accessoryEpoch) {
      if(!isCurrent())resetAccessoryControl();
      else {
        accessoryController=null;
        accessoryRun.disabled=false;
      }
    }
  }
});

accessoryMultiRun.addEventListener('click',async event=>{
  if(!event.isTrusted || accessoryMultiRun.disabled || !accessoryFirst || accessoryController || accessoryMultiController)return;
  const first=accessoryFirst;
  if(!accessoryOrderIsCurrent(first.ordered)){resetAccessoryControl();return;}
  resetAccessoryFixed();
  accessoryFirst=null;
  accessoryMultiRun.disabled=true;
  accessoryMultiStatus.hidden=false;
  accessoryMultiStatus.textContent='追加の架空相場3例を実験中…';
  const epoch=++accessoryMultiEpoch;
  const controller=new AbortController();
  accessoryMultiController=controller;
  const isCurrent=()=>epoch===accessoryMultiEpoch && accessoryOrderIsCurrent(first.ordered);
  const tokens=new Set([first.scenarioToken]);
  const trials=[first.stats];
  try {
    while(trials.length<ACCESSORY_TRIAL_COUNT) {
      const value=await requestAccessoryTrial(first.ordered,controller);
      if(!isCurrent())return;
      if(controller.signal.aborted || !validAccessoryResponse(value,first.ordered) ||
         value.engine_source_sha256!==first.engine || value.baseline_fingerprint!==first.baseline ||
         value.a.model_effective_sha256!==first.aFingerprint || value.b.model_effective_sha256!==first.bFingerprint ||
         tokens.has(value.scenario_token))throw Error('Invalid accessory trial');
      tokens.add(value.scenario_token);
      trials.push(accessoryTrialStats(value));
    }
    renderAccessoryTrialResults(trials,accessoryMultiResult,accessoryMultiRows,accessoryMultiSummary);
    accessoryMultiStatus.textContent='4例の結果を集計しました。再度試すには初回の実験から始めてください。';
  } catch {
    if(!isCurrent())return;
    clearAccessoryMultiResult();
    accessoryMultiStatus.textContent='追加実験を完了できませんでした。再度試すには初回の実験から始めてください。';
  } finally {
    if(epoch===accessoryMultiEpoch) {
      if(!isCurrent())resetAccessoryControl();
      else accessoryMultiController=null;
    }
  }
});

function sameAccessoryFingerprints(a,b) {
  return a.engine_source_sha256===b.engine_source_sha256 && a.baseline_fingerprint===b.baseline_fingerprint &&
    a.a.model_effective_sha256===b.a.model_effective_sha256 && a.b.model_effective_sha256===b.b.model_effective_sha256;
}

function sameFixedAccessoryResult(a,b) {
  return sameAccessoryFingerprints(a,b) && a.scenario_token===b.scenario_token &&
    a.daily_synthetic_prices.every((price,i)=>Object.is(price,b.daily_synthetic_prices[i])) &&
    ['a','b'].every(arm=>a[arm].daily_ai_signals.every((signal,i)=>signal===b[arm].daily_ai_signals[i]) &&
      ['profit_coins','max_drawdown_pct','liquidated_at_step'].every(key=>Object.is(a[arm][key],b[arm][key])));
}

async function runFixedAccessory(verify) {
  if(accessoryFixedController || (verify?accessoryFixedVerify.disabled:accessoryFixedRun.disabled))return;
  const first=verify?accessoryFixedFirst:null;
  if(verify && !first)return;
  const ordered=first?.ordered??currentAccessoryOrder();
  if(!accessoryOrderIsCurrent(ordered) || !availableAccessoryModel(ordered.model_id) ||
     ordered.amount===null || ordered.leverage===null || !distinctAccessoryMethods(ordered)) {
    resetAccessoryFixed();
    return;
  }
  if(!verify)resetAccessoryFixed();
  accessoryFixedFirst=null;
  const epoch=++accessoryFixedEpoch;
  const controller=new AbortController();
  accessoryFixedController=controller;
  accessoryFixedRun.disabled=true;
  accessoryFixedVerify.disabled=true;
  accessoryFixedStatus.textContent=verify?'同じ4例を再計算中…':'固定の架空相場4例を実験中…';
  const isCurrent=()=>epoch===accessoryFixedEpoch && accessoryOrderIsCurrent(ordered);
  const trials=[],tokens=new Set();
  try {
    for(let case_number=1;case_number<=ACCESSORY_TRIAL_COUNT;case_number++) {
      const value=await requestAccessoryTrial({...ordered,case_number},controller,ACCESSORY_FIXED_PATH);
      if(!isCurrent())return;
      if(controller.signal.aborted || !validAccessoryResponse(value,ordered,case_number) ||
         tokens.has(value.scenario_token) || (trials.length && !sameAccessoryFingerprints(value,trials[0]))) {
        throw Error('Invalid fixed accessory trial');
      }
      tokens.add(value.scenario_token);
      trials.push(value);
    }
    if(verify) {
      accessoryFixedStatus.textContent=trials.every((trial,i)=>sameFixedAccessoryResult(trial,first.trials[i])) ?
        '同じ条件の同じ架空相場で結果一致' : '初回と再計算の結果が一致しませんでした。';
    } else {
      renderAccessoryTrialResults(trials.map(accessoryTrialStats),accessoryFixedResult,accessoryFixedRows,accessoryFixedSummary);
      accessoryFixedFirst={ordered,trials};
      accessoryFixedVerify.hidden=false;
      accessoryFixedVerify.disabled=false;
      accessoryFixedStatus.textContent='固定の架空相場4例を集計しました。';
    }
  } catch {
    if(!isCurrent())return;
    accessoryFixedStatus.textContent=verify?
      '再計算結果の一致を確認できませんでした（通信またはデータ検証失敗）。':'固定の4例を完了できませんでした。';
  } finally {
    if(epoch===accessoryFixedEpoch) {
      if(!isCurrent())resetAccessoryFixed();
      else {
        accessoryFixedController=null;
        updateAccessoryFixedRun();
      }
    }
  }
}
accessoryFixedRun.addEventListener('click',event=>{
  if(event.isTrusted)return runFixedAccessory(false);
});
accessoryFixedVerify.addEventListener('click',event=>{
  if(event.isTrusted)return runFixedAccessory(true);
});

const compareModel = element('quickCompareModel');
const compareRun = element('quickCompareRun');
const compareStatus = element('quickCompareStatus');
const compareResults = element('quickCompareResults');
const compareDecisionDiff = element('quickCompareDecisionDiff');
const compareDecisionSummary = element('quickCompareDecisionSummary');
const compareDecisionRows = element('quickCompareDecisionRows');
const multiPanel = element('quickCompareMulti');
const multiRun = element('quickCompareMultiRun');
const multiStatus = element('quickCompareMultiStatus');
const multiResults = element('quickCompareMultiResults');
const multiCards = element('quickCompareMultiCards');
const compareExport = element('quickCompareExport');
const recordExportHelp = element('quickRecordExportHelp');
const recordExportStatus = element('quickRecordExportStatus');
const MAX_COMPARISON_JSON_BYTES = 64 * 1024;
const comparisonDownloadUrls = new Map();
const modelChangedMessage = 'モデル設定が変化した可能性があるため、追加の比較を中断しました。';
const engineChangedMessage = '予測エンジンが変化した可能性があるため、追加比較を中断しました。';
const compareAnnouncement = document.createElement('span');
compareAnnouncement.className='quick-status-announcement';
let compareBase = null;
let comparePair = null;
let comparisonRecord = null;
let compareEpoch = 0;
let compareController = null;
let compareBusy = false;

function clearMultiResults() {
  comparisonRecord=null;
  compareExport.hidden=true;
  compareExport.disabled=true;
  recordExportHelp.hidden=false;
  recordExportStatus.textContent='';
  multiResults.hidden=true;
  multiCards.replaceChildren();
  multiStatus.textContent='';
}
function resetCompareResult() {
  compareEpoch++;
  compareController?.abort();
  compareController=null;
  compareBusy=false;
  comparePair=null;
  clearMultiResults();
  compareResults.hidden=true;
  compareResults.replaceChildren();
  compareDecisionDiff.hidden=true;
  compareDecisionSummary.textContent='';
  compareDecisionRows.replaceChildren();
  compareStatus.textContent='';
  compareAnnouncement.textContent='';
}
function clearCompare() {
  compareBase=null;
  element('quickCompare').hidden=true;
  resetCompareResult();
  compareModel.replaceChildren();
  updateCompareControls();
}
function selectedCompareModel() {
  const id=compareModel.value;
  return id!==compareBase?.model_id && compareChoices.has(id) ? id : null;
}
function multiComparisonRunning() {
  // A running single comparison has already cleared the previous pair.
  return compareBusy && comparePair!==null;
}
function updateCompareControls() {
  compareModel.disabled=!compareBase || compareBusy || compareModel.children.length<=1;
  compareRun.disabled=compareModel.disabled || !selectedCompareModel();
  multiPanel.hidden=!comparePair || comparePair.b.model_id!==selectedCompareModel();
  multiRun.disabled=multiPanel.hidden || compareBusy || !!dialogueController || !!sessionController;
  compareExport.disabled=compareExport.hidden=
    !comparisonRecord || multiPanel.hidden || multiResults.hidden || compareBusy;
  recordExportHelp.hidden=!compareExport.hidden;
  if(compareExport.hidden)recordExportStatus.textContent='';
  element('quickChatGPTAsk').disabled=multiComparisonRunning() || !!dialogueController;
  element('quickChatGPTStatusCheck').disabled=multiComparisonRunning() || !!sessionController;
}
function refreshCompareModels() {
  const baseLabel=compareChoices.get(compareBase.model_id);
  if(baseLabel===undefined) {
    clearCompare();
    return;
  }
  const baseRenamed=compareBase.choice_label!==baseLabel;
  if(baseRenamed)compareBase={...compareBase,choice_label:baseLabel};
  const prior=compareModel.value;
  const choices=[...compareChoices].filter(([id])=>id!==compareBase.model_id);
  const options=compareModel.children;
  if(!baseRenamed && options.length===choices.length+1 && choices.every(([id,name],index)=>
    options[index+1].value===id && options[index+1].textContent===name))return;
  const placeholder=document.createElement('option');
  placeholder.value='';
  placeholder.textContent='AIを選択';
  compareModel.replaceChildren(placeholder,...choices.map(([id,name])=>{
    const option=document.createElement('option');
    option.value=id;
    option.textContent=name;
    return option;
  }));
  compareModel.value=choices.some(([id])=>id===prior) ? prior : '';
  if(prior && !compareModel.value) {
    resetCompareResult();
    compareStatus.textContent='選んだAIは現在利用できません。別のAIを選んでください。';
  } else if(compareBusy || !compareResults.hidden) {
    resetCompareResult();
    compareStatus.textContent='AI一覧を更新しました。もう一度比較できます。';
  }
  if(!choices.length)compareStatus.textContent='選べるAIが1種類のため、比較できません。';
  else if(!prior)compareStatus.textContent='';
  updateCompareControls();
}
function setCompareMessage(status,message) {
  status.textContent=message;
  if(compareAnnouncement.parentNode!==statusField)statusField.append(compareAnnouncement);
  compareAnnouncement.textContent=message;
}
function compareStrategy(value) {
  if(value.model_id!=='self' || value.companion_strategy===null)return null;
  return validatedStrategy(value.companion_strategy,value.model_id,value.model_id) ?? undefined;
}
function showCompare(value,ordered,modelName) {
  if(!validCompareOutcome(value,ordered.model_id) || !compareChoices.has(ordered.model_id))return;
  compareBase={model_id:ordered.model_id,model_name:modelName,
    choice_label:compareChoices.get(ordered.model_id),
    amount:ordered.amount,leverage:ordered.leverage,scenario_token:value.scenario_token,scenario_kind:value.scenario_kind,
    daily_synthetic_prices:[...value.daily_synthetic_prices],profit_coins:value.profit_coins,
    daily_ai_signals:Object.freeze([...value.daily_ai_signals]),
    max_drawdown_pct:value.max_drawdown_pct,liquidated_at_step:value.liquidated_at_step,
    model_effective_sha256:value.model_effective_sha256,
    engine_source_sha256:value.engine_source_sha256,
    strategy:compareStrategy(value)};
  refreshCompareModels();
  element('quickCompare').hidden=false;
}
function compareCard(label,name,value) {
  const card=document.createElement('article');
  const heading=document.createElement('h4');
  heading.textContent=label+'：'+name;
  card.append(heading);
  for(const text of [
    '架空の損益：'+signedMoney(value.profit_coins)+' C',
    '最大下落率：'+money(value.max_drawdown_pct)+'%',
    '強制終了：'+(value.liquidated_at_step===null ? 'なし' : '第'+value.liquidated_at_step+'日'),
  ]) {
    const line=document.createElement('p');
    line.textContent=text;
    card.append(line);
  }
  return card;
}
function comparisonOutcome(value) {
  return {profit_coins:value.profit_coins,max_drawdown_pct:value.max_drawdown_pct,
    liquidated_at_step:value.liquidated_at_step};
}
function compareDecisionCell(value,day) {
  const cell=document.createElement('td');
  cell.textContent=value.daily_ai_signals[day-1]==='LONG' ? '株を持つ' : '現金で待つ';
  if(value.liquidated_at_step!==null && day>value.liquidated_at_step) {
    const note=document.createElement('small');
    note.textContent='強制終了後・未適用';
    cell.append(note);
  }
  return cell;
}
function renderCompareDecisions(a,b) {
  const signals=a.daily_ai_signals;
  let different=0;
  const rows=signals.map((signal,index)=>{
    const day=index+1, differs=signal!==b.daily_ai_signals[index];
    if(differs)different++;
    const row=document.createElement('tr');
    const dayHeader=document.createElement('th');
    const comparison=document.createElement('td');
    dayHeader.setAttribute('scope','row');
    dayHeader.textContent='第'+day+'日';
    comparison.textContent=differs ? '違う' : '同じ';
    row.dataset.different=String(differs);
    row.append(dayHeader,compareDecisionCell(a,day),compareDecisionCell(b,day),comparison);
    return row;
  });
  const aLong=signals.filter(signal=>signal==='LONG').length;
  const bLong=b.daily_ai_signals.filter(signal=>signal==='LONG').length;
  compareDecisionSummary.textContent='判断が違う日：'+different+'/12日 ／ シグナル上で株を持つ日：A '+aLong+'日・B '+bLong+'日';
  compareDecisionRows.replaceChildren(...rows);
  compareDecisionDiff.hidden=false;
}
function comparisonTrial(caseNumber,kind,a,b) {
  return {case_number:caseNumber,kind,scenario_kind:a.scenario_kind,scenario_token:a.scenario_token,
    daily_synthetic_prices:[...a.daily_synthetic_prices],
    a:comparisonOutcome(a),b:comparisonOutcome(b)};
}
function comparisonModel(model) {
  return {model_id:model.model_id,display_name:model.model_name,
    model_effective_sha256:model.model_effective_sha256};
}
function validCompareReply(value,ordered,scenario) {
  return !!value && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype &&
    validPracticeResult(value,ordered) && validCompareOutcome(value,ordered.model_id) &&
    value.initial_balance===BALANCE && value.cash_held===BALANCE-ordered.amount &&
    value.scenario_kind===(scenario ? 'replay' : 'new') && validScenarioToken(value.scenario_token) &&
    (!scenario || value.scenario_token===scenario.scenario_token) &&
    value.daily_synthetic_prices.every((price,index)=>Object.hasOwn(value.daily_synthetic_prices,index) &&
      (!scenario || Object.is(price,scenario.daily_synthetic_prices[index])));
}
function beginCompareRequest(modelId) {
  const controller=new AbortController();
  const baseEpoch=practiceEpoch,reqEpoch=++compareEpoch;
  compareController=controller;
  compareBusy=true;
  updateCompareControls();
  return {
    signal:controller.signal,
    current:()=>practiceEpoch===baseEpoch && compareEpoch===reqEpoch && selectedCompareModel()===modelId,
    finish:()=>{
      if(compareEpoch!==reqEpoch)return;
      compareController=null;
      compareBusy=false;
      updateCompareControls();
    },
  };
}
compareModel.addEventListener('change',()=>{
  if(!compareBase)return;
  resetCompareResult();
  updateCompareControls();
});
compareRun.addEventListener('click',async()=>{
  const base=compareBase,modelId=selectedCompareModel();
  if(busy || compareBusy || !base || !modelId)return;
  resetCompareResult();
  const {signal,current,finish}=beginCompareRequest(modelId);
  const ordered={model_id:modelId,amount:base.amount,leverage:base.leverage,
    scenario_token:base.scenario_token};
  const modelName=compareChoices.get(modelId);
  compareStatus.textContent='比較を計算しています…';
  try {
    const value=await request('/api/quick-practice',ordered,signal);
    if(!current())return;
    if(!validCompareReply(value,ordered,base))throw Error('比較条件を確認できませんでした');
    const strategy=compareStrategy(value),displayName=practiceModelName(value,{...ordered,model_name:modelName});
    compareResults.replaceChildren(compareCard('A',base.model_name,base),
      compareCard('B',displayName,value));
    compareResults.hidden=false;
    const fingerprint=value.model_effective_sha256;
    const fingerprintsAvailable=validFingerprint(base.model_effective_sha256) && validFingerprint(fingerprint);
    const engineHash=base.engine_source_sha256;
    const engineMatches=validFingerprint(engineHash) && value.engine_source_sha256===engineHash;
    if(fingerprintsAvailable && engineMatches && base.strategy!==undefined && strategy!==undefined)
      comparePair={a:base,b:{model_id:modelId,model_name:displayName,strategy,
        scenario_token:value.scenario_token,model_effective_sha256:fingerprint,...comparisonOutcome(value)},engineHash};
    setCompareMessage(compareStatus,'架空価格13点共通／投入額・倍率共通（'+money(base.amount)+' C・×'+base.leverage+'）'+
      (fingerprintsAvailable ? '' : '。現在のAPIではモデル同一性を確認できないため追加比較はできません。')+
      (engineMatches ? '' : ' '+engineChangedMessage));
    renderCompareDecisions(base,value);
  } catch {
    if(current())setCompareMessage(compareStatus,'比較できませんでした。もう一度お試しください。');
  } finally {
    finish();
  }
});
function validMultiOutcome(value,model) {
  const strategy=compareStrategy(value);
  return strategy!==undefined && strategy?.approach===model.strategy?.approach &&
    strategy?.risk_percent===model.strategy?.risk_percent &&
    value.daily_balances.every(balance=>balance>=value.cash_held) &&
    Math.abs(value.final_balance-(BALANCE+value.profit_coins))<=0.02;
}
function multiCard(title,outcomes,average=false,format=money) {
  const card=document.createElement('article');
  const heading=document.createElement('h5');
  heading.textContent=title;
  card.append(heading);
  const profitLabel=average ? '参考平均損益' : '架空の損益';
  const drawdownLabel=average ? '最大下落率の平均' : '最大下落率';
  for(const [index,value] of outcomes.entries()) {
    const line=document.createElement('p');
    const profit=format(value.profit_coins);
    const signed=profit==='-0' || profit==='0' ? '0' : (value.profit_coins>0 ? '+' : '')+profit;
    line.textContent=(index===0 ? 'A' : 'B')+'：'+profitLabel+' '+signed+' C ／ '+drawdownLabel+' '+
      format(value.max_drawdown_pct || 0)+'%';
    card.append(line);
  }
  return card;
}
function comparisonAverage(trials,key) {
  return {
    profit_coins:trials.reduce((sum,trial)=>sum+trial[key].profit_coins,0)/trials.length,
    max_drawdown_pct:trials.reduce((sum,trial)=>sum+trial[key].max_drawdown_pct,0)/trials.length,
  };
}
multiRun.addEventListener('click',async()=>{
  if(busy || multiRun.disabled || compareBusy || !comparePair ||
     dialogueController || sessionController)return;
  const {a,b,engineHash}=comparePair;
  if(selectedCompareModel()!==b.model_id || !compareChoices.has(a.model_id))return;
  clearMultiResults();
  compareAnnouncement.textContent='';
  const {signal,current,finish}=beginCompareRequest(b.model_id);
  multiStatus.textContent='追加の3例を計算しています…';
  const tokens=new Set([a.scenario_token]);
  const pairs=[];
  const orderedA={model_id:a.model_id,amount:a.amount,leverage:a.leverage};
  try {
    for(let trial=0;trial<3;trial++) {
      const valueA=await request('/api/quick-practice',orderedA,signal);
      if(!current())return;
      if(!validCompareReply(valueA,orderedA,null) || tokens.has(valueA.scenario_token))
        throw Error('追加の比較条件を確認できませんでした');
      if(valueA.engine_source_sha256!==engineHash)
        return setCompareMessage(multiStatus,engineChangedMessage);
      if(valueA.model_effective_sha256!==a.model_effective_sha256)
        return setCompareMessage(multiStatus,modelChangedMessage);
      if(!validMultiOutcome(valueA,a))throw Error('追加の比較条件を確認できませんでした');
      tokens.add(valueA.scenario_token);
      const orderedB={model_id:b.model_id,amount:a.amount,leverage:a.leverage,
        scenario_token:valueA.scenario_token};
      const valueB=await request('/api/quick-practice',orderedB,signal);
      if(!current())return;
      if(!validCompareReply(valueB,orderedB,valueA))throw Error('追加の比較条件を確認できませんでした');
      if(valueB.engine_source_sha256!==engineHash)
        return setCompareMessage(multiStatus,engineChangedMessage);
      if(valueB.model_effective_sha256!==b.model_effective_sha256)
        return setCompareMessage(multiStatus,modelChangedMessage);
      if(!validMultiOutcome(valueB,b))throw Error('追加の比較条件を確認できませんでした');
      pairs.push(comparisonTrial(trial+2,'new',valueA,valueB));
    }
    const averages=['a','b'].map(key=>comparisonAverage(pairs,key));
    multiCards.replaceChildren(...pairs.map((pair,index)=>multiCard('シナリオ'+(index+1),[pair.a,pair.b])),
      multiCard('モデル別の参考平均',averages,true));
    multiResults.hidden=false;
    setCompareMessage(multiStatus,'追加の3例の比較が完了しました。');
    comparisonRecord={
      schema:'synthetic-practice-comparison-v1',
      mode:'SIMPLE_SYNTHETIC_PRACTICE_ONLY',
      real_market:false,order_placed:false,persisted:false,xp_awarded:false,
      disclaimer:'ユーザー操作で出力された編集可能なローカル記録です。実市場の検証、公式監査証明、将来の同一モデル実行を保証するものではありません。',
      settings:{amount_coins:a.amount,leverage:a.leverage,days:12},
      models:{a:comparisonModel(a),b:comparisonModel(b)},
      engine_source_sha256:engineHash,
      trials:[comparisonTrial(1,'published_initial',a,b),...pairs],
      reference_averages:{a:averages[0],b:averages[1]},
    };
  } catch (error) {
    if(current()) {
      const message=error?.code==='PRACTICE_ENGINE_SOURCE_UNVERIFIED' ? engineChangedMessage :
        error?.status===409 ? modelChangedMessage : '追加の比較ができませんでした。もう一度お試しください。';
      setCompareMessage(multiStatus,message);
    }
  } finally {
    finish();
  }
});
function setRecordExportMessage(message) {
  recordExportStatus.textContent=message;
  setCompareMessage(multiStatus,message);
}
compareExport.addEventListener('click',event=>{
  if(!event.isTrusted || compareExport.disabled || compareExport.hidden || !comparisonRecord)return;
  let url;
  try {
    const exportedAt=new Date().toISOString();
    const {a,b}=comparisonRecord.models;
    const namesFit=a.display_name.length+b.display_name.length<=MAX_COMPARISON_JSON_BYTES;
    const blob=namesFit ? new Blob([JSON.stringify({...comparisonRecord,exported_at:exportedAt},null,2)+'\n'],
      {type:'application/json'}) : null;
    if(!blob || blob.size>MAX_COMPARISON_JSON_BYTES) {
      setRecordExportMessage('記録が64 KiBを超えたため、ダウンロードできませんでした。');
      return;
    }
    const link=document.createElement('a');
    url=URL.createObjectURL(blob);
    link.href=url;
    const utcStamp=exportedAt.slice(0,19).replace(/[-:]/g,'').replace('T','-');
    link.download='synthetic-ai-comparison-'+utcStamp+'.json';
    link.click();
    setRecordExportMessage('JSONのダウンロードをリクエストしました。保存先やブロックの有無はブラウザで確認してください。');
  } catch {
    setRecordExportMessage('JSONのダウンロードを開始できませんでした。もう一度お試しください。');
  } finally {
    // Leave the URL available for the browser to start reading the download.
    if(url) comparisonDownloadUrls.set(url,setTimeout(()=>{
      comparisonDownloadUrls.delete(url);
      URL.revokeObjectURL(url);
    },1000));
  }
});
function hasComparisonKeys(value,...keys) {
  return value!==null && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype &&
    Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
}
function validExportTimestamp(value) {
  if(typeof value!=='string' || !value.endsWith('Z'))return false;
  const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/.exec(value);
  if(!match)return false;
  const wholeSecond=match[1]+'.000Z';
  const date=new Date(wholeSecond);
  return Number.isFinite(date.getTime()) && date.toISOString()===wholeSecond;
}
function validImportedModel(value) {
  return hasComparisonKeys(value,'model_id','display_name','model_effective_sha256') &&
    typeof value.model_id==='string' && value.model_id.length<=45 &&
    value.model_id===value.model_id.trim() && /^(self|demo_[a-z_]{1,40}|zip_[a-f0-9]{32})$/.test(value.model_id) &&
    typeof value.display_name==='string' && value.display_name.length<=MAX_COMPARISON_JSON_BYTES &&
    validFingerprint(value.model_effective_sha256);
}
function validImportedOutcome(value,amount) {
  return hasComparisonKeys(value,'profit_coins','max_drawdown_pct','liquidated_at_step') &&
    Number.isFinite(value.profit_coins) && value.profit_coins>=-amount &&
    value.profit_coins<=Number.MAX_SAFE_INTEGER && Number.isFinite(value.max_drawdown_pct) &&
    value.max_drawdown_pct>=0 && value.max_drawdown_pct<=100 &&
    (value.liquidated_at_step===null || (Number.isInteger(value.liquidated_at_step) &&
      value.liquidated_at_step>=1 && value.liquidated_at_step<=12));
}
function validImportedComparison(value) {
  if(!hasComparisonKeys(value,'schema','exported_at','mode','real_market','order_placed','persisted','xp_awarded',
    'disclaimer','settings','models','engine_source_sha256','trials','reference_averages'))return false;
  if(value.schema!=='synthetic-practice-comparison-v1' || !validExportTimestamp(value.exported_at) ||
    value.mode!=='SIMPLE_SYNTHETIC_PRACTICE_ONLY' || value.real_market!==false || value.order_placed!==false ||
    value.persisted!==false || value.xp_awarded!==false || typeof value.disclaimer!=='string' ||
    !validFingerprint(value.engine_source_sha256))return false;
  const {settings,models,trials,reference_averages:averages}=value;
  if(!hasComparisonKeys(settings,'amount_coins','leverage','days') ||
    !Number.isInteger(settings.amount_coins) || settings.amount_coins<1 || settings.amount_coins>BALANCE ||
    !Number.isInteger(settings.leverage) || settings.leverage<1 || settings.leverage>25 || settings.days!==12 ||
    !hasComparisonKeys(models,'a','b') || !validImportedModel(models.a) || !validImportedModel(models.b) ||
    models.a.model_id===models.b.model_id || !Array.isArray(trials) || trials.length!==4 ||
    !hasComparisonKeys(averages,'a','b'))return false;
  const tokens=new Set();
  for(const [index,trial] of trials.entries()) {
    if(!hasComparisonKeys(trial,'case_number','kind','scenario_kind','scenario_token','daily_synthetic_prices','a','b') ||
      trial.case_number!==index+1 || trial.kind!==(index===0 ? 'published_initial' : 'new') ||
      (trial.scenario_kind!=='new' && !(index===0 && trial.scenario_kind==='replay')) ||
      !validScenarioToken(trial.scenario_token) || tokens.has(trial.scenario_token) ||
      !Array.isArray(trial.daily_synthetic_prices) || trial.daily_synthetic_prices.length!==13 ||
      !trial.daily_synthetic_prices.every(price=>Number.isFinite(price) && price>0 && price<=1e12) ||
      !validImportedOutcome(trial.a,settings.amount_coins) || !validImportedOutcome(trial.b,settings.amount_coins))return false;
    tokens.add(trial.scenario_token);
  }
  const additionalTrials=trials.slice(1);
  return ['a','b'].every(key=>{
    const average=averages[key];
    if(!hasComparisonKeys(average,'profit_coins','max_drawdown_pct'))return false;
    const expected=comparisonAverage(additionalTrials,key);
    return Object.keys(expected).every(metric=>Number.isFinite(average[metric]) &&
      Math.abs(average[metric]-expected[metric])<=Math.max(1e-8,Math.abs(expected[metric])*1e-12));
  });
}

const importFile=element('quickImportFile');
const importStatus=element('quickImportStatus');
const importResults=element('quickImportResults');
const importDetails=element('quickImportDetails');
const importCards=element('quickImportCards');
const importCompareFile=element('quickImportCompareFile');
const importCompareStatus=element('quickImportCompareStatus');
const importCompareResults=element('quickImportCompareResults');
const importCompareChecklist=element('quickImportCompareChecklist');
const importReferenceCards=element('quickImportReferenceCards');
const importCompareDescription='quickImportCompareHelp quickImportHelp quickImportWarning';
let importEpoch=0;
let importCompareEpoch=0;
let primaryImportRecord=null;
function clearImportComparison() {
  importCompareEpoch++;
  importCompareResults.hidden=true;
  importCompareChecklist.replaceChildren();
  importReferenceCards.replaceChildren();
  importCompareStatus.textContent='';
  importCompareFile.removeAttribute('aria-invalid');
  importCompareFile.setAttribute('aria-describedby',importCompareDescription);
}
function clearComparisonImport() {
  importEpoch++;
  primaryImportRecord=null;
  importCompareFile.disabled=true;
  importCompareFile.value='';
  clearImportComparison();
  importResults.hidden=true;
  importDetails.replaceChildren();
  importCards.replaceChildren();
  importStatus.textContent='';
  importFile.removeAttribute('aria-invalid');
}
function showComparisonImportError(message) {
  importFile.setAttribute('aria-invalid','true');
  importStatus.textContent=message;
}
function importedModelLines(record) {
  return ['a','b'].map(key=>{
    const model=record.models[key];
    const line=document.createElement('p');
    const name=document.createElement('bdi');
    const characters=Array.from(model.display_name);
    name.textContent=characters.length>160 ? characters.slice(0,159).join('')+'…' : model.display_name;
    line.textContent=key.toUpperCase()+' モデル SHA-256（冒頭）：'+model.model_effective_sha256.slice(0,12)+' ／ ';
    line.append(name);
    return line;
  });
}
function importedEngineLine(record) {
  const engine=document.createElement('p');
  engine.textContent='エンジン SHA-256（冒頭）：'+record.engine_source_sha256.slice(0,12);
  return engine;
}
function renderComparisonImport(record) {
  const cards=record.trials.map(trial=>{
    const kind=trial.scenario_kind==='replay' ? '再挑戦' : '新規';
    return multiCard('ケース'+trial.case_number+'（'+kind+'）',[trial.a,trial.b],false,String);
  });
  const {a,b}=record.reference_averages;
  cards.push(multiCard('参考平均（ケース2〜4）',[a,b],true,String));
  importDetails.replaceChildren(...importedModelLines(record),importedEngineLine(record));
  importCards.replaceChildren(...cards);
  importResults.hidden=false;
  importStatus.textContent='JSONの形式と参考平均の計算を確認しました。';
}
async function readComparisonImport(files,current,showError) {
  if(!files?.length)return;
  if(files.length!==1 || files[0].size<=0 || files[0].size>MAX_COMPARISON_JSON_BYTES) {
    showError('空でない64 KiB以下のJSONファイルを1つ選択してください。');
    return;
  }
  let source;
  try {
    source=await files[0].text();
  } catch {
    if(current())showError('ファイルを読み込めませんでした。');
    return;
  }
  if(!current())return;
  try {
    const record=JSON.parse(source);
    if(validImportedComparison(record))return record;
  } catch {
    // Invalid JSON gets the same feedback as a record that fails validation.
  }
  showError('比較記録のJSON形式または参考平均が正しくありません。');
}
importFile.addEventListener('change',async()=>{
  clearComparisonImport();
  const epoch=importEpoch,current=()=>epoch===importEpoch;
  const record=await readComparisonImport(importFile.files,current,showComparisonImportError);
  if(!current() || !record)return;
  renderComparisonImport(record);
  primaryImportRecord=record;
  importCompareFile.disabled=false;
});

function sameImportedModel(first,second) {
  return first.model_id===second.model_id && first.model_effective_sha256===second.model_effective_sha256;
}
function sameImportedOutcomes(first,second,secondSlots) {
  return ['a','b'].every((slot,index)=>{
    const otherSlot=secondSlots[index];
    const sameMetrics=(a,b)=>a.profit_coins===b.profit_coins && a.max_drawdown_pct===b.max_drawdown_pct;
    return first.trials.every((trial,caseIndex)=>{
      const a=trial[slot],b=second.trials[caseIndex][otherSlot];
      return sameMetrics(a,b) && a.liquidated_at_step===b.liquidated_at_step;
    }) && sameMetrics(first.reference_averages[slot],second.reference_averages[otherSlot]);
  });
}
function importedReferenceCard(record,title) {
  const {a,b}=record.reference_averages;
  const card=multiCard(title,[a,b],true,String);
  const initial=document.createElement('p');
  initial.textContent='ケース1の種別：'+(record.trials[0].scenario_kind==='replay' ? '再挑戦' : '新規');
  card.append(...importedModelLines(record),importedEngineLine(record),initial);
  return card;
}
function renderImportedRecordComparison(first,second) {
  const secondSlots=sameImportedModel(first.models.a,second.models.a) ? ['a','b'] : ['b','a'];
  const conditions=[
    ['エンジンの識別値',first.engine_source_sha256===second.engine_source_sha256],
    ['試算額',first.settings.amount_coins===second.settings.amount_coins],
    ['損益倍率',first.settings.leverage===second.settings.leverage],
    ['4ケースの架空相場トークン',first.trials.every((trial,index)=>
      trial.scenario_token===second.trials[index].scenario_token)],
    ['4ケースの架空価格（各13点）',first.trials.every((trial,index)=>
      trial.daily_synthetic_prices.every((price,day)=>Object.is(price,second.trials[index].daily_synthetic_prices[day])))],
    ['2モデルのIDと設定の識別値（A/Bの順不同）',['a','b'].every((slot,index)=>
      sameImportedModel(first.models[slot],second.models[secondSlots[index]]))],
  ];
  importCompareChecklist.replaceChildren(...conditions.map(([label,match])=>{
    const item=document.createElement('li');
    item.textContent=label+'：'+(match ? 'はい（一致）' : 'いいえ（不一致）');
    return item;
  }));
  importReferenceCards.replaceChildren(importedReferenceCard(first,'1件目の記録'),importedReferenceCard(second,'2件目の記録'));
  importCompareResults.hidden=false;
  if(!conditions.every(([,match])=>match)) {
    importCompareStatus.textContent='条件が異なるため、記録された損益は公平に比較できません。';
    return;
  }
  const inconsistent=sameImportedOutcomes(first,second,secondSlots) ? '' :
    ' 同じ条件で記録内容に食い違いがあります。どちらが正しいかは確認できません。';
  importCompareStatus.textContent='一覧の条件は一致しています。記録の真正性を証明するものではありません。'+inconsistent;
}
importCompareFile.addEventListener('change',async()=>{
  clearImportComparison();
  const first=primaryImportRecord;
  if(!first || importCompareFile.disabled)return;
  const epoch=importCompareEpoch;
  const current=()=>epoch===importCompareEpoch && first===primaryImportRecord;
  const second=await readComparisonImport(importCompareFile.files,current,message=>{
    importCompareFile.setAttribute('aria-invalid','true');
    importCompareFile.setAttribute('aria-describedby',importCompareDescription+' quickImportCompareStatus');
    importCompareStatus.textContent=message;
  });
  if(current() && second)renderImportedRecordComparison(first,second);
});
window.addEventListener('pagehide',()=>{
  clearComparisonImport();
  importFile.value='';
});

function revealResult(value,ordered) {
  const panel=element('quickResult');
  panel.replaceChildren();
  const heading=document.createElement('h3');
  heading.textContent='12日間の試算結果';
  const summary=document.createElement('p');
  const isSelf=ordered.model_id==='self' && (value.model_id===undefined || value.model_id==='self');
  const resultModelName=practiceModelName(value,ordered);
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
  replayIsSelf=isSelf;
  replayZipId = /^zip_[a-f0-9]{32}$/.test(ordered.model_id) &&
    value.model_id===ordered.model_id && zipCharacters.some(item=>item.id===ordered.model_id) ?
    ordered.model_id : null;
  replay={...value,companion_strategy:validatedStrategy(value.companion_strategy,ordered.model_id,value.model_id)};
  replayDay=0;
  renderReplay();
  lastScenarioToken=value.scenario_token;
  element('quickSameScenario').checked=false;
  updateScenarioOption();
  panel.hidden=false;
  element('quickNext').hidden=false;
  statusField.textContent='試算が完了しました。AI・試算額・倍率を変えてもう一度試せます。';
  showCompare(value,ordered,resultModelName);
}
element('quickRun').addEventListener('click',async()=>{
  if(busy||compareBusy||!pending)return;
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
    if(!validPracticeResult(value,ordered)||
       !validScenarioToken(value.scenario_token)||
       value.scenario_kind!==(ordered.scenario_token ? 'replay' : 'new')||
       (ordered.scenario_token && value.scenario_token!==ordered.scenario_token)||
       !Number.isFinite(value.normal_profit_coins)||
       !Number.isFinite(value.normal_final_balance)||
       !Number.isFinite(value.normal_max_drawdown_pct))
      throw Error('練習結果の形式が不正です');
    if(epoch!==practiceEpoch)return;
    if(beforeReveal) {
      const hasCompanion=typeof value.companion_name==='string' && value.companion_name.trim()!=='' &&
        !!validatedStrategy(value.companion_strategy,ordered.model_id,value.model_id);
      preReveal={value,ordered,hasCompanion,index:0,answers:[]};
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
