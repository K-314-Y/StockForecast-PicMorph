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
const formatMetric=new Intl.NumberFormat('ja-JP',{maximumFractionDigits:6});
let state;
let controls=[];
let busy=false;
let refreshRequired=false;
let batchEpoch=0;
let batchPending=false;
let batchNeedsReload=false;

async function request(path='',input) {
  const response=await fetch(API+path,{mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',
    signal:AbortSignal.timeout(['/historical','/batch-history'].includes(path)?40000:20000),
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
  const cards=$('batch-metrics');
  cards.replaceChildren();
  for(const [key,label,unit] of batchMetrics) {
    const metric=report.metrics[key];
    const article=document.createElement('article');
    const title=document.createElement('h4');
    title.textContent=label;
    const means=document.createElement('p');
    means.textContent=`平均（各期間を同じ重みで集計） 基準 ${formatMetric.format(metric.baseline_mean)}${unit} ／ 候補 ${formatMetric.format(metric.candidate_mean)}${unit}`;
    const counts=document.createElement('p');
    counts.textContent=`候補が良い ${metric.wins} ／ 同じ ${metric.ties} ／ 悪い ${metric.losses}`;
    article.append(title,means,counts);
    cards.append(article);
  }
  $('batch-downside').textContent=`全期間で最も大きな下落率は基準 ${downside.baseline.max_drawdown_pct}% ／ 候補 ${downside.candidate.max_drawdown_pct}%。最も低い仮想損益は基準 ${downside.baseline.worst_profit_coins}コイン ／ 候補 ${downside.candidate.worst_profit_coins}コイン。`;
  $('batch-codes').replaceChildren(...report.by_code.map(({code,windows,metrics})=>{
    const item=document.createElement('li');
    const means=batchMetrics.map(([key,label,unit])=>`${label} ${formatMetric.format(metrics[key].baseline_mean)}${unit} → ${formatMetric.format(metrics[key].candidate_mean)}${unit}`);
    item.textContent=`${code}（${windows}期間、基準 → 候補） ${means.join(' ／ ')}`;
    return item;
  }));
  batchResult.hidden=false;
}

function clearResults() {
  result.hidden=true;
  historicalResult.hidden=true;
  historicalStatus.textContent='';
  batchResult.hidden=true;
  batchStatus.textContent='';
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
batch.addEventListener('click',()=>{
  if(batch.disabled)return;
  batchResult.hidden=true;
  batchPending=true;
  const epoch=++batchEpoch;
  void run('ローカルの過去株価で一括比較しています…',async()=>{
    try {
      const report=await request('/batch-history',comparisonContext());
      if(epoch!==batchEpoch)return;
      renderBatchComparison(report);
      batchStatus.textContent='過去株価の一括比較が完了しました。';
    } catch(error) {
      if(epoch===batchEpoch)throw error;
    } finally {batchPending=false;}
  },batchStatus);
});

function clearBatchOnDeparture() {
  if(!batchPending && batchResult.hidden)return;
  batchEpoch++;
  batchNeedsReload=true;
  batchResult.hidden=true;
  batchStatus.textContent='表示中のキャラと設定を再読込してから比較してください。';
  updateControls();
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearBatchOnDeparture();});
window.addEventListener('pagehide',clearBatchOnDeparture);
void load();
