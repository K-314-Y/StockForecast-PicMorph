const API='/api/accessory-analysis/v1';
const FOCUS={trend:'値動きの流れ',momentum:'直近の勢い',volatility:'値動きの大きさ',reversion:'行き過ぎ後の戻り'};
const $=id=>document.getElementById(id);
const settings=$('settings');
const save=$('save');
const compare=$('compare');
const reload=$('reload');
const status=$('status');
const result=$('result');
const historical=$('historical-compare');
const historicalStatus=$('historical-status');
const historicalResult=$('historical-result');
const batch=$('batch-compare');
const batchStatus=$('batch-status');
const batchResult=$('batch-result');
const adjustedSplit=$('adjusted-split-compare');
const adjustedSplitStatus=$('adjusted-split-status');
const adjustedSplitResult=$('adjusted-split-result');
const registrationReview=$('registration-review');
const registrationConfirm=$('registration-confirm');
const registrationList=$('registration-list');
const registrationStatus=$('registration-status');
const registrationPreview=$('registration-preview');
const formatMetric=new Intl.NumberFormat('ja-JP',{maximumFractionDigits:6});
let state;
let controls=[];
let busy=false;
let refreshRequired=false;
let batchEpoch=0;
let batchPending=false;
let batchNeedsReload=false;
let registrationRequest;
let reviewedRegistration;
let registrationExpiry;

async function request(path='',input,signal) {
  const timeout=AbortSignal.timeout(['/historical','/batch-history','/adjusted-split'].includes(path)?40000:20000);
  const response=await fetch(API+path,{mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',
    signal:signal ? AbortSignal.any([signal,timeout]) : timeout,
    ...(input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})});
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
  historical.disabled=compare.disabled || !state.policies.some(rule=>state.equipped.visible_kinds.includes(rule.kind_id));
  batch.disabled=historical.disabled || batchNeedsReload;
  adjustedSplit.disabled=batch.disabled;
  registrationReview.disabled=batch.disabled;
  registrationConfirm.disabled=registrationReview.disabled || !reviewedRegistration;
  registrationList.disabled=busy;
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
  batchNeedsReload=false;
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
  historicalStatus.textContent=state.policies.some(rule=>visible_kinds.includes(rule.kind_id)) ? '' :
    '過去の株価で比較するには、表示中の登録キャラの装備に使える分析ルールを保存してください。';
}

function appliedRules(report) {
  const applied=report.provenance.applied_rules.map(policy=>`${policy.kind_id}（${FOCUS[policy.focus]}・強度${policy.intensity}）`);
  return `適用した設定　${applied.join('、') || 'なし'}`;
}

function renderReports(report,container,isHistorical=false) {
  container.replaceChildren();
  for(const [title,data] of [['基準',report.baseline],['候補',report.candidate]]) {
    const article=document.createElement('article');
    const heading=document.createElement(isHistorical?'h4':'h3');
    heading.textContent=title;
    article.append(heading);
    for(const line of [Object.entries(FOCUS).map(([id,name])=>`${name} ${data.parameters.plugin_weights[id]}%`).join('、'),
      ...(isHistorical?[`Brierスコア　${data.brier}（小さいほど確率予測の誤差が小さい）`]:[]),
      `モデルハッシュ　${data.effective_sha256}`,`${isHistorical?'仮想損益':'架空収支'}　${data.profit_coins}コイン`,
      `収益率　${data.return_pct}%`,`最大下落率　${data.max_drawdown_pct}%`,
      ...(isHistorical?[]:[`日次シグナル　${data.signals.join(' / ')}`])]) {
      const p=document.createElement('p');
      p.textContent=line;
      article.append(p);
    }
    container.append(article);
  }
}

function renderComparison(report) {
  $('delta').textContent=`異なる日次シグナルは12日中${report.difference.different_signals}日。架空収支の差は${report.difference.profit_coins}コイン。分析重みは${report.weights_changed?'変更あり':'変更なし'}、モデルハッシュは${report.effective_hash_changed?'変更あり':'変更なし'}。`;
  $('rules').textContent=appliedRules(report);
  renderReports(report,$('reports'));
  result.hidden=false;
}

function renderHistoricalComparison(report) {
  const market=report.market;
  if(report.scope!=='ACCESSORY_RULES_HISTORICAL_LOCAL_12' || report.holdout_evaluated!==false ||
     report.read_only!==true || market?.source_origin!=='LOCAL_JPX_REPORT_CACHE_2024' || market.adjusted!==false) {
    throw Object.assign(new Error('ローカルの過去株価の比較結果を確認できませんでした。'),{status:503});
  }
  $('historical-period').textContent=`出典　${market.source}（未調整） ／ 銘柄コード ${market.code} ／ 履歴開始 ${market.period_start}、予測前の最終日 ${market.history_end}、再現終了 ${market.period_end}`;
  $('historical-warning').textContent=`候補期間は${market.eligible_windows}件で互いに重なります。再現したのは1期間です。独立した検証用データでの評価は行っていません。 ${market.warning}`;
  $('historical-delta').textContent=`異なる日次シグナルは12日中${report.difference.different_signals}日。仮想損益の差は${report.difference.profit_coins}コイン。`;
  $('historical-rules').textContent=appliedRules(report);
  renderReports(report,$('historical-reports'),true);
  historicalResult.hidden=false;
}

const batchMetrics=[['brier','Brierスコア（低いほど誤差が小さい）',''],
  ['profit_coins','仮想損益','コイン'],['max_drawdown_pct','最大下落率','%']];

function renderMetricCards(metrics,cards,includeDelta=false) {
  cards.replaceChildren();
  for(const [key,label,unit] of batchMetrics) {
    const metric=metrics[key];
    const article=document.createElement('article');
    const title=document.createElement(includeDelta?'h5':'h4');
    title.textContent=label;
    const means=document.createElement('p');
    means.textContent=`平均（各期間を同じ重みで集計） 基準 ${formatMetric.format(metric.baseline_mean)}${unit} ／ 候補 ${formatMetric.format(metric.candidate_mean)}${unit}`;
    if(includeDelta)means.textContent+=` ／ 差（候補−基準） ${formatMetric.format(metric.delta)}${unit==='%'?'ポイント':unit}`;
    const counts=document.createElement('p');
    counts.textContent=`候補が良い ${metric.wins} ／ 同じ ${metric.ties} ／ 悪い ${metric.losses}`;
    article.append(title,means,counts);
    cards.append(article);
  }
}

function downsideText(downside) {
  return `全期間で最も大きな下落率は基準 ${downside.baseline.max_drawdown_pct}% ／ 候補 ${downside.candidate.max_drawdown_pct}%。最も低い仮想損益は基準 ${downside.baseline.worst_profit_coins}コイン ／ 候補 ${downside.candidate.worst_profit_coins}コイン。`;
}

function renderCodeMeans(container,byCode) {
  container.replaceChildren(...byCode.map(({code,windows,metrics})=>{
    const item=document.createElement('li');
    const means=batchMetrics.map(([key,label,unit])=>`${label} ${formatMetric.format(metrics[key].baseline_mean)}${unit} → ${formatMetric.format(metrics[key].candidate_mean)}${unit}`);
    item.textContent=`${code}（${windows}期間、基準 → 候補） ${means.join(' ／ ')}`;
    return item;
  }));
}

function renderBatchComparison(report) {
  const {coverage,market,downside}=report;
  if(report.scope!=='ACCESSORY_RULES_HISTORICAL_LOCAL_NONOVERLAP_V1' || report.holdout_evaluated!==false ||
     report.read_only!==true || report.weighting!=='equal_per_window' ||
     market?.source_origin!=='LOCAL_JPX_REPORT_CACHE_2024' || market.adjusted!==false) {
    throw Object.assign(new Error('ローカルの一括比較結果を確認できませんでした。'),{status:503});
  }
  $('batch-coverage').textContent=`${coverage.codes}銘柄・${coverage.selected_windows}期間（重なる候補は${coverage.eligible_windows}件）。全体の日付範囲は${coverage.period_start}〜${coverage.period_end}。出典は${market.source}（未調整）。`;
  $('batch-warning').textContent=report.notice+' '+market.warning;
  $('batch-signals').textContent=`シグナルが異なった日数は、各期間を合計して${report.signal_comparisons}日のうち${report.different_signals}日です。`;
  $('batch-rules').textContent=appliedRules(report);
  renderMetricCards(report.metrics,$('batch-metrics'));
  $('batch-downside').textContent=downsideText(downside);
  renderCodeMeans($('batch-codes'),report.by_code);
  batchResult.hidden=false;
}

function renderAdjustedSplit(report) {
  const {market,phases}=report;
  if(report.scope!=='ACCESSORY_RULES_ADJUSTED_CHRONOLOGY_RESEARCH_V1' || report.holdout_evaluated!==false ||
     report.read_only!==true || report.research_only!==true || report.weighting!=='equal_per_window' ||
     report.rights_verified!==false || report.point_in_time_verified!==false || report.corporate_actions_verified!==false ||
     market?.source_origin!=='LOCAL_PRIVATE_JQUANTS_ADJUSTED_RESEARCH' || market.adjusted!==true || market.manifests_verified!==true) {
    throw Object.assign(new Error('調整済み研究データの比較結果を確認できませんでした。'),{status:503});
  }
  $('adjusted-split-coverage').textContent=`出典はローカル保管のJ-Quants V2調整済み終値。${market.codes}銘柄、各${market.sessions_per_code}営業日。欠損日は${market.missing_sessions.join('、')}。分割日は${report.split_date}です。`;
  $('adjusted-split-caveats').textContent=report.notice+' 24営業日の履歴と12営業日の再現がそろう期間を選び、10日を超える日付の空きはまたぎません。価格変動による選別はしません。';
  $('adjusted-split-rules').textContent=appliedRules(report);
  const container=$('adjusted-split-phases');
  container.replaceChildren();
  for(const [key,label] of [['early','前半（遡及比較）'],['later','後半（遡及比較）']]) {
    const phase=phases[key];
    const section=document.createElement('section');
    const heading=document.createElement('h4');
    heading.textContent=label;
    const coverage=document.createElement('p');
    coverage.textContent=`${phase.calendar_start}〜${phase.calendar_end}（各銘柄${phase.sessions_per_code}営業日）。${phase.periods}期間を比較。採用範囲 ${phase.window_start}〜${phase.window_end}。`;
    const signals=document.createElement('p');
    signals.textContent=`異なるシグナルは合計${phase.signal_comparisons}日のうち${phase.different_signals}日。`;
    const metrics=document.createElement('div');
    renderMetricCards(phase.metrics,metrics,true);
    const downside=document.createElement('p');
    downside.textContent=downsideText(phase.downside);
    const details=document.createElement('details');
    const summary=document.createElement('summary');
    summary.textContent=`${label.slice(0,2)}の銘柄ごとの平均`;
    const codes=document.createElement('ul');
    renderCodeMeans(codes,phase.by_code);
    details.append(summary,codes);
    section.append(heading,coverage,signals,metrics,downside,details);
    container.append(section);
  }
  const direction={better:'候補が良い',worse:'候補が悪い',tie:'同じ'};
  $('adjusted-split-directions').replaceChildren(...batchMetrics.map(([key,label])=>{
    const item=document.createElement('li');
    const pair=report.direction_by_metric[key];
    item.textContent=`${label}　前半 ${direction[pair.early]} ／ 後半 ${direction[pair.later]}`;
    return item;
  }));
  adjustedSplitResult.hidden=false;
}

function clearResults() {
  result.hidden=true;
  historicalResult.hidden=true;
  historicalStatus.textContent='';
  batchResult.hidden=true;
  batchStatus.textContent='';
  adjustedSplitResult.hidden=true;
  adjustedSplitStatus.textContent='';
  clearRegistrationPreview();
}

function clearRegistrationPreview() {
  registrationRequest?.abort();
  registrationRequest=undefined;
  reviewedRegistration=undefined;
  clearTimeout(registrationExpiry);
  registrationPreview.hidden=true;
}

function renderRegistrationReview({review}) {
  const {context,source_revisions:sources,protocol}=review;
  $('registration-context').textContent=`登録キャラ ${context.character_id}。版数はキャラ ${context.active_revision}、装備 ${context.equipment_revision}、ルール ${context.expected_revision}、元モデル ${sources.source_revision}、相棒 ${sources.companion_revision}、編成 ${sources.lineup_revision}、育成 ${sources.growth_revision}。`;
  $('registration-rules').textContent=appliedRules({provenance:review});
  $('registration-schedule').textContent=`固定したJST日付の翌日以降にある、検証済みの最初の${protocol.evaluation_sessions_per_code}営業日を再現し、その直前${protocol.lookback_sessions}営業日を履歴に使います。今回の最短日は${review.earliest_possible_day}です。実際の営業日は後から確認し、値動きで期間を選別しません。`;
  $('registration-codes').textContent=`対象${protocol.codes.length}銘柄　${protocol.codes.join('、')}`;
  $('registration-metrics').textContent=`指標はBrierスコア、仮想損益、最大下落率、シグナルが異なった日数。各モデル・銘柄の仮想資金は${protocol.initial_virtual_coins_per_model_and_code.toLocaleString('ja-JP')}コイン、売買手数料は${protocol.trade_fee_bps/100}%です。`;
  const models=$('registration-models');
  models.replaceChildren();
  for(const [key,label] of [['base_model','元モデル'],['baseline','基準'],['candidate','候補']]) {
    const model=review[key];
    const article=document.createElement('article');
    const heading=document.createElement('h4');
    heading.textContent=label;
    const summary=document.createElement('p');
    summary.textContent=`期間 ${model.fast_window}／${model.slow_window}。仮想投資比率 ${formatMetric.format(model.risk_fraction*100)}%。`;
    const weights=document.createElement('p');
    weights.textContent=Object.entries(FOCUS).map(([kind,name])=>`${name} ${model.plugin_weights[kind]}%（感度${model.plugin_strengths[kind]}）`).join('、');
    article.append(heading,summary,weights);
    models.append(article);
  }
  registrationPreview.hidden=false;
}

const JST_TIME=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',dateStyle:'medium',timeStyle:'medium'});
const READINESS_TEXT=new Map([
  ['pending_input','入力待ち。対象の入力パッケージがありません。'],
  ['pending_code_mismatch','確認待ち。実行コードが固定時の指紋と一致しません。'],
  ['pending_invalid_input','確認待ち。入力の形式または安全性を確認できませんでした。'],
  ['pending_evidence_review','根拠の確認待ち。入力の構造は一致しました。'],
]);

async function showReadiness(button,output,registration_id) {
  button.disabled=true;
  output.textContent='入力の準備状況を確認しています…';
  try {
    const result=await request('/registration/readiness',{registration_id});
    const message=READINESS_TEXT.get(result.status);
    if(!message || result.score_allowed!==false)throw Error('Unexpected readiness response');
    const counts=result.actual;
    output.textContent=message+(counts ?
      ` 申告された履歴 ${counts.history_first}〜${counts.history_last}（${counts.history_sessions}日）、評価対象 ${counts.evaluation_first}〜${counts.evaluation_last}（${counts.evaluation_sessions}日）。${counts.codes}銘柄・${counts.rows}行。営業日、権利、当時の入手可能性、価格調整と時刻の根拠は未確認です。` : '')+
      ' 採点は保留です。';
  } catch(error) {
    output.textContent=error.status===404 ? '固定記録が見つかりません。一覧を表示し直してください。' :
      '固定記録または入力を安全に確認できませんでした。';
  } finally {button.disabled=false;}
}

const EVIDENCE_LABELS={source:'取得元',retrieval:'取得記録',calendar:'営業日',adjustment:'価格調整',
  rights:'利用権限',point_in_time:'当時の利用可能性'};
const EVIDENCE_STATES=new Map([['missing','未添付'],['unsafe','安全に読取不可'],
  ['hash_mismatch','不一致'],['hash_match','一致']]);

async function showEvidence(button,output,registration_id) {
  button.disabled=true;
  output.textContent='証拠ファイルを照合しています…';
  try {
    const result=await request('/registration/evidence',{registration_id});
    const audit=result.evidence_audit;
    const message=READINESS_TEXT.get(result.status);
    if(!message || result.score_allowed!==false)throw Error();
    if(result.status!=='pending_evidence_review') {
      if(audit!==null)throw Error();
      output.textContent=message+' 証拠ファイルの照合と採点は保留です。';
      return;
    }
    const lines=Object.entries(EVIDENCE_LABELS).map(([key,label])=>{
      const state=EVIDENCE_STATES.get(audit.categories[key]);
      if(!state)throw Error();
      return label+'：'+state;
    });
    output.textContent=[`ハッシュ一致 ${audit.hash_matches}／6件`,...lines,
      'ハッシュが一致しても、資料の真正性や利用権限は証明されません。採点は行いません。'].join('\n');
  } catch(error) {
    output.textContent=error.status===404 ? '固定記録が見つかりません。一覧を表示し直してください。' :
      '証拠ファイルを安全に照合できませんでした。';
  } finally {button.disabled=false;}
}

function renderRegistrationList(records) {
  const list=$('registration-records');
  list.replaceChildren();
  for(const record of records) {
    const item=document.createElement('li');
    const summary=document.createElement('p');
    summary.id='registration-summary-'+record.id;
    summary.textContent=`固定 ${JST_TIME.format(new Date(record.created_at))}（JST） ／ 最短日 ${record.earliest_possible_day} ／ 評価待ち（未検証） ／ ID ${record.id}`;
    const button=document.createElement('button');
    button.type='button';
    button.textContent='データの準備状況を確認';
    button.setAttribute('aria-describedby',summary.id);
    const output=document.createElement('p');
    output.setAttribute('role','status');
    button.addEventListener('click',()=>void showReadiness(button,output,record.id));
    const evidenceButton=document.createElement('button');
    evidenceButton.type='button';
    evidenceButton.textContent='証拠ファイルを照合する';
    evidenceButton.setAttribute('aria-describedby',summary.id);
    const audit=document.createElement('p');
    audit.className='evidence-result';
    audit.setAttribute('role','status');
    evidenceButton.addEventListener('click',()=>void showEvidence(evidenceButton,audit,record.id));
    item.append(summary,button,output,evidenceButton,audit);
    list.append(item);
  }
  $('registration-history').hidden=false;
}

function comparisonContext() {
  const {character_id,active_revision,equipment_revision}=state.equipped;
  return {character_id,active_revision,equipment_revision,expected_revision:state.revision};
}

async function run(message,action,output=status) {
  busy=true;
  output.textContent=message;
  updateControls();
  try { await action(); }
  catch(error) {
    if(error.status===409) {
      refreshRequired=true;
      clearResults();
    }
    output.textContent=error.status?error.message:'接続に失敗しました。設定を再読込してください。';
  } finally {
    busy=false;
    updateControls();
  }
}

function load() {
  refreshRequired=true;
  clearResults();
  return run('設定を読み込んでいます…',async()=>{
    state=await request();
    renderSettings();
    refreshRequired=false;
    status.textContent='設定を読み込みました。';
  });
}

settings.addEventListener('change',()=>{clearResults();updateControls();});
reload.addEventListener('click',load);
save.addEventListener('click',()=>{
  if(!window.confirm('種類別の分析設定を保存しますか？ 装備や予測モデルは変更しません。'))return;
  clearResults();
  void run('分析設定を保存しています…',async()=>{
    const saved=await request('',{expected_revision:state.revision,policies:editedPolicies()});
    state={...state,...saved,stale_kinds:[]};
    renderSettings();
    status.textContent='分析設定を保存しました。';
  });
});
compare.addEventListener('click',()=>{
  result.hidden=true;
  void run('同じ架空12日間で比較しています…',async()=>{
    renderComparison(await request('/compare',comparisonContext()));
    status.textContent='比較が完了しました。';
  });
});
historical.addEventListener('click',()=>{
  if(historical.disabled)return;
  historicalResult.hidden=true;
  void run('ローカルの過去株価で比較しています…',async()=>{
    renderHistoricalComparison(await request('/historical',comparisonContext()));
    historicalStatus.textContent='過去株価の比較が完了しました。';
  },historicalStatus);
});
function runMultipleWindows({button,section,output,path,render,message,done}) {
  if(button.disabled)return;
  section.hidden=true;
  batchPending=true;
  const epoch=++batchEpoch;
  void run(message,async()=>{
    try {
      const report=await request(path,comparisonContext());
      if(epoch!==batchEpoch)return;
      render(report);
      output.textContent=done;
    } catch(error) {
      if(epoch===batchEpoch)throw error;
    } finally {batchPending=false;}
  },output);
}

batch.addEventListener('click',()=>runMultipleWindows({button:batch,section:batchResult,output:batchStatus,
  path:'/batch-history',render:renderBatchComparison,message:'ローカルの過去株価で一括比較しています…',done:'過去株価の一括比較が完了しました。'}));
adjustedSplit.addEventListener('click',()=>runMultipleWindows({button:adjustedSplit,section:adjustedSplitResult,output:adjustedSplitStatus,
  path:'/adjusted-split',render:renderAdjustedSplit,message:'ローカルの調整済み研究データで前半・後半を比較しています…',done:'調整済み株価の前半・後半の比較が完了しました。'}));

registrationReview.addEventListener('click',()=>{
  if(registrationReview.disabled)return;
  clearRegistrationPreview();
  const controller=new AbortController();
  registrationRequest=controller;
  void run('固定する設定を確認しています…',async()=>{
    try {
      const response=await request('/registration/preview',comparisonContext(),controller.signal);
      if(controller.signal.aborted)return;
      renderRegistrationReview(response);
      reviewedRegistration=response;
      registrationStatus.textContent='5分以内に内容を確認して固定してください。';
      registrationExpiry=setTimeout(()=>{
        clearRegistrationPreview();
        registrationStatus.textContent='プレビューの有効期限が切れました。固定する内容を確認し直してください。';
        updateControls();
      },1000*response.valid_for_seconds);
    } catch(error) {if(!controller.signal.aborted)throw error;}
    finally {if(registrationRequest===controller)registrationRequest=undefined;}
  },registrationStatus);
});
registrationConfirm.addEventListener('click',()=>{
  if(registrationConfirm.disabled || !reviewedRegistration || !window.confirm('この設定と検証手順を固定しますか？ 同じ内容は同じ日に一度だけ記録でき、固定記録は上書きできません。'))return;
  const {preview_token,review}=reviewedRegistration;
  clearRegistrationPreview();
  $('registration-history').hidden=true;
  void run('設定をローカルに固定しています…',async()=>{
    const {registration}=await request('/registration',{...review.context,preview_token});
    registrationStatus.textContent=`設定を固定しました。評価待ち（データ未取得・未検証）。最短日は${registration.earliest_possible_day}です。`;
  },registrationStatus);
});
registrationList.addEventListener('click',()=>{
  if(registrationList.disabled)return;
  $('registration-history').hidden=true;
  void run('固定記録を読み込んでいます…',async()=>{
    const {registrations}=await request('/registrations');
    renderRegistrationList(registrations);
    registrationStatus.textContent=registrations.length?`${registrations.length}件の固定記録を表示しました。`:'固定記録はまだありません。';
  },registrationStatus);
});

function clearBatchOnDeparture() {
  if(!batchPending && batchResult.hidden && adjustedSplitResult.hidden)return;
  batchEpoch++;
  batchNeedsReload=true;
  batchResult.hidden=true;
  adjustedSplitResult.hidden=true;
  batchStatus.textContent='表示中のキャラと設定を再読込してから比較してください。';
  adjustedSplitStatus.textContent=batchStatus.textContent;
  updateControls();
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearBatchOnDeparture();});
window.addEventListener('pagehide',clearBatchOnDeparture);
function clearRegistrationOnDeparture() {
  if(!registrationRequest && !reviewedRegistration)return;
  clearRegistrationPreview();
  registrationStatus.textContent='画面を離れたため、固定する内容を確認し直してください。';
  updateControls();
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearRegistrationOnDeparture();});
window.addEventListener('pagehide',clearRegistrationOnDeparture);
// S107: read-only, checked-in aggregate sample. Never associated with a real registration.
const snapshotButton=$('synthetic-snapshot-show');
const snapshotResult=$('synthetic-snapshot-result');
const snapshotStatus=$('synthetic-snapshot-status');
const metricLabels=[
  ['brier','確率予測の誤差（Brier・低いほど良い）',''],
  ['profit_coins','平均仮想損益（大きいほど良い）',' コイン'],
  ['max_drawdown_pct','平均最大下落率（低いほど良い）','%'],
];
function snapshotArticle(title,lines) {
  const article=document.createElement('article'), heading=document.createElement('h4');
  heading.textContent=title;
  article.append(heading);
  for(const line of lines) {
    const text=document.createElement('p');
    text.textContent=line;
    article.append(text);
  }
  return article;
}
function renderSyntheticSnapshot(report) {
  const data=report?.summary;
  if(report?.schema!==1 || report.kind!=='SYNTHETIC_TEST_SNAPSHOT_ONLY' ||
     report.scenario!=='S106_PAIRED_V1' || typeof report.source_commit!=='string' ||
     !/^[a-f0-9]{40}$/.test(report.source_commit) || typeof report.fixture_sha256!=='string' ||
     !/^[a-f0-9]{64}$/.test(report.fixture_sha256) || data?.scope!=='SYNTHETIC_FROZEN_COMPARISON_ONLY' ||
     data.real_market_history!==false || data.holdout_evaluated!==false || data.score_allowed!==false ||
     data.codes!==10 || data.history_sessions_per_code!==24 || data.replay_sessions_per_code!==12 ||
     data.signal_comparisons!==120 || !Number.isInteger(data.different_signals) ||
     data.different_signals<0 || data.different_signals>120)throw Error('Invalid sample');
  const models=['baseline','candidate'].map((slot,index)=>{
    const model=report.models?.[slot], weights=model?.plugin_weights;
    if(!weights || !Object.keys(FOCUS).every(key=>Number.isInteger(weights[key]) && weights[key]>=0 && weights[key]<=100) ||
       Object.keys(FOCUS).reduce((sum,key)=>sum+weights[key],0)!==100)throw Error('Invalid model');
    return snapshotArticle(index?'テスト用候補（装備ルールあり）':'テスト用基準',[
      Object.entries(FOCUS).map(([key,label])=>label+' '+weights[key]+'%').join('、'),
    ]);
  });
  const cards=metricLabels.map(([key,label,unit])=>{
    const metric=data.metrics?.[key];
    if(!metric || ![metric.baseline_mean,metric.candidate_mean].every(Number.isFinite) ||
       ![metric.wins,metric.ties,metric.losses].every(n=>Number.isInteger(n)&&n>=0&&n<=10) ||
       metric.wins+metric.ties+metric.losses!==10 ||
       (key==='brier' && ![metric.baseline_mean,metric.candidate_mean].every(n=>n>=0&&n<=2)) ||
       (key==='max_drawdown_pct' && ![metric.baseline_mean,metric.candidate_mean].every(n=>n>=0&&n<=100)))
      throw Error('Invalid metric');
    return snapshotArticle(label,[
      '基準 '+formatMetric.format(metric.baseline_mean)+unit,
      '候補 '+formatMetric.format(metric.candidate_mean)+unit,
      '候補 − 基準 '+formatMetric.format(metric.candidate_mean-metric.baseline_mean)+unit,
      '候補が良い '+metric.wins+' / 同じ '+metric.ties+' / 悪い '+metric.losses+'（テスト用銘柄数）',
    ]);
  });
  $('synthetic-snapshot-models').replaceChildren(...models);
  $('synthetic-snapshot-metrics').replaceChildren(...cards);
  $('synthetic-snapshot-coverage').textContent='10銘柄分の架空価格、履歴24日・再現12日。各モデル10,000仮想コイン、手数料0.1%。';
  $('synthetic-snapshot-signals').textContent='売買判断の違い '+data.different_signals+' / '+data.signal_comparisons+' 回';
  $('synthetic-snapshot-provenance').textContent='S106 / '+report.scenario+' / ソースコミット '+report.source_commit+' / テスト用固定設定SHA-256 '+report.fixture_sha256;
  snapshotResult.hidden=false;
}
snapshotButton.addEventListener('click',async()=>{
  if(snapshotButton.disabled)return;
  snapshotButton.disabled=true;
  snapshotResult.hidden=true;
  snapshotStatus.textContent='保存済みの合成結果を読み込んでいます…';
  try {
    const res=await fetch('/synthetic-frozen-report-v1.json',{mode:'same-origin',cache:'no-store',redirect:'error',
      signal:AbortSignal.timeout(5000)});
    if(!res.ok)throw Error('Sample unavailable');
    renderSyntheticSnapshot(await res.json());
    snapshotStatus.textContent='合成テスト結果を表示しました。実データの採点は行っていません。';
  } catch {
    snapshotStatus.textContent='保存済みの合成テスト結果を確認できませんでした。';
  } finally {snapshotButton.disabled=false;}
});
void load();
