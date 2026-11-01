const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString('ja-JP', {maximumFractionDigits: 2});
let growthRevision = null, ticket = null;
async function call(path, body) {
  const response = await fetch(path, body ? {method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : undefined);
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'ゲームサーバーに接続できません');
  return value;
}
async function loadGrowth() {
  const growth = await call('/api/growth');
  growthRevision = growth.revision;
  const mine = growth.slots.find(x => x.slot === 'mine');
  $('growthInfo').textContent = '現在 Lv.' + mine.level + ' / ' + mine.xp + ' XP（実績ごとに1回）';
  const select = $('gear');
  select.replaceChildren();
  for (const item of mine.gear_options) {
    const option = document.createElement('option');
    option.value = item.id;
    option.disabled = !item.unlocked;
    option.textContent = item.icon + ' ' + item.name + (item.unlocked ? '' : '（あと ' + (item.unlock_xp - mine.xp) + ' XP）');
    select.append(option);
  }
  select.value = mine.gear;
  return growth;
}
$('claim').addEventListener('click', async () => {
  if (!ticket || growthRevision === null) return;
  $('claim').disabled = true;
  try {
    const result = await call('/api/training/complete', {
      ticket, expected_growth_revision:growthRevision
    });
    ticket = null;
    const gained = Object.entries(result.earned_xp).map(([k, v]) => k + ': +' + v + ' XP').join(' / ');
    $('reward').textContent = gained + '。同じ実績の報酬は重複しません。';
    await loadGrowth();
  } catch(e) {
    $('reward').textContent = e.message;
    try { await loadGrowth(); } catch {}
    $('claim').disabled = false;
  }
});
$('equip').addEventListener('click', async () => {
  $('equip').disabled = true;
  try {
    const growth = await call('/api/growth/equip', {
      slot:'mine', gear_id:$('gear').value,expected_growth_revision:growthRevision
    });
    $('gearStatus').textContent = '装備を保存しました。現在revision ' + growth.revision;
    await loadGrowth();
  } catch(e) {
    $('gearStatus').textContent = '変更できません: ' + e.message;
    try { await loadGrowth(); } catch {}
  } finally { $('equip').disabled = false; }
});
loadGrowth().catch(e => $('growthInfo').textContent = e.message);

$('play').addEventListener('click', async () => {
  $('play').disabled = true;
  $('status').textContent = 'Pythonから予測を取得し、Node.jsで架空コインを計算しています…';
  $('result').hidden = true;
  ticket = null;
  $('claim').disabled = true;
  try {
    const response = await fetch('/api/practice', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({allocations: {mine: 100, owl: 0, turtle: 0}}),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || '練習に失敗しました');
    if (value.mode !== 'PRACTICE_SYNTHETIC_ONLY') throw Error('結果の種類が不正です');
    ticket = value.training_ticket;
    $('claim').disabled = !ticket;
    $('reward').textContent = '';
    await loadGrowth();
    $('final').textContent = fmt(value.final_coins) + ' C';
    $('profit').textContent = (value.profit_coins >= 0 ? '+' : '') + fmt(value.profit_coins) + ' C';
    $('drawdown').textContent = fmt(value.max_drawdown_pct) + '%';
    const container = $('days');
    container.replaceChildren();
    const detail = index => {
      const button = container.children[index];
      for (const elem of container.children) elem.setAttribute('aria-pressed', String(elem === button));
      const choice = value.decisions[index];
      $('dayDetail').textContent = `${choice.step}日目: 架空価格 ${fmt(choice.price)} C、キャラの判断 ${choice.signals.mine}。累積 ${fmt(value.equity_path[index + 1])} C`;
    };
    for (let index = 0; index < value.decisions.length; index++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = String(index + 1);
      button.setAttribute('aria-label', `${index + 1}日目の結果`);
      button.setAttribute('aria-pressed', String(index === 0));
      button.addEventListener('click', () => detail(index));
      container.appendChild(button);
    }
    if (value.decisions.length) detail(0);
    $('result').hidden = false;
    $('status').textContent = '完了：架空12ステップの練習結果。予測実績・XPには反映していません。';
  } catch (error) {
    $('status').textContent = '練習に失敗しました: ' + error.message;
  } finally {
    $('play').disabled = false;
  }
});
