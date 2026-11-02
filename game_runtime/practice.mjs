/**
 * Pure JavaScript gameplay math, no Python dependencies or network calls.
 * Python may supply the forecast decisions; JS owns trading, accounting and
 * the synthetic game result. Used by the Node /api/practice preview endpoint.
 * All input is a synthetic replay plan, never broker orders or live returns.
 */
/** @type {readonly import('./contracts.js').CharacterSlot[]} */
const SLOTS = Object.freeze(['mine', 'owl', 'turtle']);
const MODE = 'PRACTICE_SYNTHETIC_ONLY';
const WARNINGS = Object.freeze([
  'すべて架空の価格と無料のゲーム内コインです。実際の投資ではありません。',
  '同じ架空資産を3キャラが運用します。銘柄分散ではありません。',
  '過去に固定した練習シナリオで、隠れた未来データを使った実力評価ではありません。',
]);

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function numeric(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(label + ' が不正です');
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {import('./contracts.js').Allocations}
 */
export function validateAllocations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...SLOTS].sort().join('|')) {
    throw new Error('3体分の配分が必要です');
  }
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {import('./contracts.js').Allocations} */
  const result = {mine: 0, owl: 0, turtle: 0};
  for (const key of SLOTS) {
    const pct = numeric(source[key], '配分', 0, 100);
    if (!Number.isInteger(pct)) throw new Error('配分は整数％です');
    result[key] = pct;
  }
  if (Object.values(result).reduce((a, b) => a + b, 0) > 100) {
    throw new Error('配分の合計が100%を超えています');
  }
  return result;
}

/**
 * @param {number} value
 * @param {number} places
 */
function rounded(value, places) {
  // Python's round uses ties-to-even. Mirror it, including rare exact half cases.
  const scale = 10 ** places;
  const scaled = value * scale;
  const nearest = Math.round(scaled);
  const tie = Math.abs(scaled - (Math.floor(scaled) + .5)) < 1e-10;
  if (tie) {
    const low = Math.floor(scaled);
    return (low % 2 === 0 ? low : low + 1) / scale;
  }
  return nearest / scale;
}

/**
 * @param {import('./contracts.js').PracticePlan} plan
 * @returns {import('./contracts.js').PracticeResult}
 */
export function runSyntheticGame(plan) {
  if (!plan || plan.mode !== MODE) throw new Error('架空データの練習プランのみ対応しています');
  const allocations = validateAllocations(plan.allocations);
  const initialCoins = numeric(plan.initial_coins, '初期コイン', .01, 1e9);
  const feeRate = numeric(plan.fee_rate, '手数料率', 0, .1);
  const initialPrice = numeric(plan.initial_price, '開始価格', .000001, 1e12);
  const prices = plan.future_prices;
  const predictions = plan.signals;
  const models = plan.models;
  if (!Array.isArray(prices) || prices.length < 1 || prices.length > 500 ||
      !Array.isArray(predictions) || predictions.length !== prices.length ||
      !models || typeof models !== 'object' ||
      Object.keys(models).sort().join('|') !== [...SLOTS].sort().join('|')) {
    throw new Error('練習プランの価格・予測・モデル数が一致しません');
  }
  if (typeof plan.model_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(plan.model_sha256)) {
    throw new Error('元モデルの識別情報がありません');
  }
  /** @type {Record<import('./contracts.js').CharacterSlot, import('./contracts.js').GameWallet>} */
  const wallets = /** @type {any} */ ({});
  for (const key of SLOTS) {
    const meta = models[key];
    if (!meta || typeof meta !== 'object') throw new Error('キャラのモデルが不足しています');
    numeric(meta.risk_fraction, 'リスク上限', 0, 1);
    if (typeof meta.effective_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.effective_sha256) ||
        !meta.plugin_weights || !meta.plugin_strengths) {
      throw new Error('モデルの識別情報が不足しています');
    }
    const initial = initialCoins * allocations[key] / 100;
    wallets[key] = {cash: initial, units: 0, fees: 0, trades: 0, initial, long_steps: 0};
  }
  const idle = initialCoins * (100 - Object.values(allocations).reduce((a, b) => a + b, 0)) / 100;
  const equity = [initialCoins];
  const decisions = [];
  let priorPrice = initialPrice;

  for (let index = 0; index < prices.length; index++) {
    const next = numeric(prices[index], '架空価格', .000001, 1e12);
    const signals = predictions[index];
    if (!signals || typeof signals !== 'object' || Array.isArray(signals) ||
        Object.keys(signals).sort().join('|') !== [...SLOTS].sort().join('|')) {
      throw new Error('予測シグナルが不足しています');
    }
    for (const key of SLOTS) {
      const signal = signals[key];
      if (signal !== 'LONG' && signal !== 'CASH') throw new Error('不明な売買判断です');
      const w = wallets[key];
      const long = signal === 'LONG';
      const risk = models[key].risk_fraction;
      if (long) w.long_steps++;
      const total = w.cash + w.units * priorPrice;
      const target = long ? total * risk : 0;
      const held = w.units * priorPrice;
      if (target > held + 1e-8) {
        const gross = Math.min(target - held, w.cash / (1 + feeRate));
        if (gross > 1e-8) {
          const fee = gross * feeRate;
          w.cash -= gross + fee;
          w.units += gross / priorPrice;
          w.fees += fee;
          w.trades++;
        }
      } else if (held > target + 1e-8) {
        const gross = held - target;
        const fee = gross * feeRate;
        w.units -= gross / priorPrice;
        w.cash += gross - fee;
        w.fees += fee;
        w.trades++;
      }
      if (w.cash < -1e-7 || w.units < -1e-7) throw new Error('仮想資金がマイナスです');
    }
    priorPrice = next;
    equity.push(idle + SLOTS.reduce((s, key) => s + wallets[key].cash + wallets[key].units * next, 0));
    decisions.push({step: index + 1, price: next, signals: {...signals}});
  }
  const final = equity[equity.length - 1] ?? initialCoins;
  let peak = equity[0] ?? initialCoins, drawdown = 0;
  for (const value of equity.slice(1)) {
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, 1 - value / peak);
  }
  /** @type {Record<import('./contracts.js').CharacterSlot, import('./contracts.js').CharacterResult>} */
  const characters = /** @type {any} */ ({});
  for (const key of SLOTS) {
    const wallet = wallets[key], model = models[key];
    characters[key] = {
      allocation_pct: allocations[key],
      initial: rounded(wallet.initial, 2),
      final: rounded(wallet.cash + wallet.units * priorPrice, 2),
      fees: rounded(wallet.fees, 3),
      trades: wallet.trades,
      long_steps: wallet.long_steps,
      risk_fraction: model.risk_fraction,
      plugin_weights: {...model.plugin_weights},
      plugin_strengths: {...model.plugin_strengths},
      effective_sha256: model.effective_sha256,
    };
  }
  return {
    mode: MODE, initial_coins: initialCoins,
    final_coins: rounded(final, 2),
    profit_coins: rounded(final - initialCoins, 2),
    return_pct: rounded((final / initialCoins - 1) * 100, 3),
    max_drawdown_pct: rounded(drawdown * 100, 3),
    benchmark_buy_hold_pct: rounded((priorPrice / initialPrice - 1) * 100, 3),
    allocations, cash_unallocated: rounded(idle, 2), steps: prices.length,
    fee_rate_pct: feeRate * 100,
    equity_path: equity.map(x => rounded(x, 2)),
    benchmark_path: [initialPrice, ...prices].map(p => rounded(initialCoins * p / initialPrice, 2)),
    decisions, characters, model_sha256: plan.model_sha256, warnings: [...WARNINGS],
  };
}
