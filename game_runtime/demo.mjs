const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString('ja-JP', {maximumFractionDigits: 2});
$('play').addEventListener('click', async () => {
  $('play').disabled = true;
  $('status').textContent = 'Pythonから予測を取得し、Node.jsで架空コインを計算しています…';
  $('result').hidden = true;
  try {
    const response = await fetch('/api/practice', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({allocations: {mine: 100, owl: 0, turtle: 0}}),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || '練習に失敗しました');
    if (value.mode !== 'PRACTICE_SYNTHETIC_ONLY') throw Error('結果の種類が不正です');
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
