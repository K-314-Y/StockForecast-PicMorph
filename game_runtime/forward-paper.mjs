/**
 * Forward-looking virtual-paper ledger core. No network calls, broker access,
 * persistence, live-data claims, server route or user-facing money.
 * ONLY a trusted server-side market adapter may supply observations/timestamps.
 * One open position per AI wallet in this first, intentionally isolated seam.
 */
import {
  MARKET_SYMBOL, MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE, TEST_FIXTURE_SOURCE,
  guardMarketQuotes, isMarketMode, isMarketPrice, nextObservation, observationSlot, utcTime,
} from './forward-market-guard.mjs';

export const FORWARD_PAPER_MODE = 'FORWARD_PAPER_CORE_UNCONNECTED';
export const MAX_FORWARD_MEDALS = 1_000_000_000_000;
export const MAX_FORWARD_WALLETS = 50;
export const FORWARD_AI_ID = /^[a-z][a-z0-9_-]{1,39}$/;
const HASH = /^[a-f0-9]{64}$/;
const ORDER_ID = /^[a-zA-Z0-9_-]{1,60}$/;
const EPS = 1e-8;

const fail = message => { throw new RangeError(message); };
function medals(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) ||
      value > MAX_FORWARD_MEDALS) fail(name + ' が不正です');
  return value;
}
function dateMs(value) {
  const time = utcTime(value);
  if (!Number.isFinite(time)) fail('時刻は有効なUTC日時で指定してください');
  return time;
}
function ledgerMode(mode) {
  return mode === FORWARD_PAPER_MODE || isMarketMode(mode);
}
function walletOf(state, id) {
  if (typeof id !== 'string' || !Object.hasOwn(state.wallets, id)) {
    fail('AI財布が存在しません');
  }
  return state.wallets[id];
}
function positionPnl(position, marketPrice) {
  const pnl = (position.direction === 'LONG' ? 1 : -1) *
    position.units * (marketPrice - position.entryPrice);
  if (!Number.isFinite(pnl) || Math.abs(pnl) > Number.MAX_SAFE_INTEGER / 100) {
    fail('損益が安全に計算できる数値範囲を超えています');
  }
  return pnl;
}
function walletEquity(wallet) {
  const equity = wallet.cash + (wallet.position
    ? wallet.position.margin + positionPnl(wallet.position, wallet.position.lastPrice)
    : 0);
  if (!Number.isFinite(equity) ||
      Math.abs(equity) > Number.MAX_SAFE_INTEGER / 100) {
    fail('残高が安全に計算できる数値範囲を超えています');
  }
  return equity;
}

function allocateWallet(ledger, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.id !== 'string' || !FORWARD_AI_ID.test(item.id) ||
      typeof item.modelHash !== 'string' || !HASH.test(item.modelHash) ||
      Object.hasOwn(ledger.wallets, item.id)) fail('AIの識別情報が不正です');
  if (Object.keys(ledger.wallets).length >= MAX_FORWARD_WALLETS) fail('AI財布が上限に達しています');
  const amount = medals(item.medals, 'AIへの配分');
  if (amount > ledger.unallocated) fail('配分が未配分メダルを超えています');
  ledger.unallocated -= amount;
  ledger.wallets[item.id] = {
    modelHash: item.modelHash, initial: amount, cash: amount,
    position: null, status: 'ACTIVE',
  };
}

export function allocateForwardWallet(ledger, item) {
  if (!ledgerMode(ledger?.mode)) fail('仮想取引台帳が不正です');
  const next = structuredClone(ledger);
  allocateWallet(next, item);
  return next;
}

/**
 * All medals are virtual. Allocation never increases total starting balance.
 * Model versions are frozen identifiers so an edited character starts a new AI.
 */
export function createForwardLedger({initialMedals, allocations, mode = FORWARD_PAPER_MODE}) {
  if (!ledgerMode(mode)) fail('仮想取引台帳のモードが不正です');
  medals(initialMedals, '開始メダル');
  if (!Array.isArray(allocations) || allocations.length < 1 ||
      allocations.length > MAX_FORWARD_WALLETS) fail('AIの配分が不正です');
  const ledger = {
    mode,
    initialMedals,
    unallocated: initialMedals,
    wallets: Object.create(null),
    pending: [],
    journal: [],
    lastBatchAt: null,
    ...(isMarketMode(mode) ? {lastTradeAt: {}} : {}),
  };
  for (const item of allocations) allocateWallet(ledger, item);
  return ledger;
}

/**
 * receivedAt MUST be stamped by the trusted server, never the player/client.
 * The order cannot be filled at an observation that already occurred.
 * In this first slice, one active or pending order is allowed per AI.
 */
export function queueForwardOrder(ledger, order, receivedAt) {
  if (!ledgerMode(ledger?.mode) || !order ||
      typeof order !== 'object' || Array.isArray(order)) fail('注文データが不正です');
  const stamp = dateMs(receivedAt);
  const interval = ledger.observationIntervalMs;
  const lastBatch = ledger.lastBatchAt === null ? -Infinity : dateMs(ledger.lastBatchAt);
  if (stamp < lastBatch || (stamp === lastBatch && interval === undefined) ||
      (interval !== undefined && ledger.pending.some(order => dateMs(order.receivedAt) > stamp))) {
    fail('過去の時刻では注文できません');
  }
  if (typeof order.id !== 'string' || !ORDER_ID.test(order.id) ||
      typeof order.symbol !== 'string' || !MARKET_SYMBOL.test(order.symbol) ||
      !['OPEN_LONG', 'OPEN_SHORT', 'CLOSE'].includes(order.action)) {
    fail('注文ID・銘柄・売買区分が不正です');
  }
  if (ledger.pending.some(o => o.id === order.id) ||
      ledger.journal.some(e => e.orderId === order.id)) fail('注文IDが重複しています');
  const wallet = walletOf(ledger, order.aiId);
  if (wallet.status !== 'ACTIVE' ||
      ledger.pending.some(o => o.aiId === order.aiId)) {
    fail('このAIは新しい注文を受け付けられません');
  }
  if (order.action === 'CLOSE') {
    if (!wallet.position || wallet.position.symbol !== order.symbol ||
        order.margin !== undefined || order.leverage !== undefined) {
      fail('決済対象のポジションがありません');
    }
  } else {
    if (wallet.position) fail('このAIはすでに株を保有しています');
    const margin = medals(order.margin, '注文メダル');
    if (!Number.isSafeInteger(order.leverage) ||
        order.leverage < 1 || order.leverage > 25 || margin > wallet.cash) {
      fail('倍率または資金が不正です');
    }
  }
  const next = structuredClone(ledger);
  next.pending.push({
    id: order.id, aiId: order.aiId, symbol: order.symbol,
    action: order.action, receivedAt,
    ...(interval === undefined ? {} : {eligibleAt: new Date(nextObservation(stamp, interval)).toISOString()}),
    ...(order.action === 'CLOSE' ? {} :
      {margin: order.margin, leverage: order.leverage}),
  });
  return next;
}

function eventObservation(quote, symbol, observedAt, sourceId) {
  const {price, tradeAt, publishedAt, ingestedAt, evidence} = quote;
  return {
    observedAt, sourceId, price,
    ...(tradeAt === undefined ? {} : {symbol, tradeAt, publishedAt, ingestedAt}),
    ...(evidence === undefined ? {} : {evidence}),
  };
}

/** Observations and policy are supplied separately by trusted server code. */
export function applyForwardBatch(ledger, {observedAt, sourceId, quotes}, {providerPolicy, now = Date.now()} = {}) {
  if (!ledgerMode(ledger?.mode)) fail('仮想取引台帳が不正です');
  const time = dateMs(observedAt);
  if (ledger.lastBatchAt !== null && time <= dateMs(ledger.lastBatchAt)) {
    fail('市場観測は必ず時系列順に処理してください');
  }
  if (!quotes || typeof quotes !== 'object' || Array.isArray(quotes)) fail('銘柄一覧が不正です');
  const entries = Object.entries(quotes);
  if (entries.length > 200) fail('銘柄一覧が不正です');
  if (entries.some(([symbol]) => !MARKET_SYMBOL.test(symbol))) fail('銘柄コードが不正です');
  const market = isMarketMode(ledger.mode);
  const interval = ledger.observationIntervalMs;
  let accepted;
  if (market) {
    if ((ledger.mode === MOCK_MARKET_PAPER_MODE) !== (sourceId === MOCK_MARKET_SOURCE)) {
      fail('市場観測元と台帳のモードが一致しません');
    }
    if (interval !== undefined && ledger.lastBatchAt !== null &&
        observationSlot(time, interval) <= observationSlot(dateMs(ledger.lastBatchAt), interval)) {
      fail('この観測間隔のバッチは処理済みです');
    }
    accepted = guardMarketQuotes({sourceId, quotes}, time, ledger.lastTradeAt, providerPolicy, now);
    if (interval !== undefined && [...accepted.values()].some(quote => !quote.evidence)) {
      fail('市場観測の出典証拠がありません');
    }
  } else {
    if (sourceId !== TEST_FIXTURE_SOURCE) fail('試験台帳には試験用の観測元が必要です');
    accepted = new Map(entries.map(([symbol, price]) => {
      if (!isMarketPrice(price)) fail('市場価格が不正です');
      return [symbol, {price, trade: time}];
    }));
  }
  const next = structuredClone(ledger);
  next.lastBatchAt = observedAt;
  if (market) {
    for (const [symbol, quote] of accepted) next.lastTradeAt[symbol] = quote.tradeAt;
  }
  // Mark all held positions before any new orders. A cash gap cannot erase
  // losses, and another AI wallet can never be used as collateral.
  for (const [aiId, wallet] of Object.entries(next.wallets)) {
    const position = wallet.position;
    const quote = position && accepted.get(position.symbol);
    if (!quote) continue;
    position.lastPrice = quote.price;
    if (walletEquity(wallet) <= EPS) {
      wallet.cash = 0;
      wallet.position = null;
      wallet.status = 'LIQUIDATED';
      next.journal.push({
        kind: 'LIQUIDATED', aiId, modelHash: wallet.modelHash,
        ...eventObservation(quote, position.symbol, observedAt, sourceId),
      });
    }
  }
  const remaining = [];
  for (const order of next.pending) {
    const wallet = walletOf(next, order.aiId);
    if (wallet.status !== 'ACTIVE') {
      next.journal.push({kind:'CANCELLED', orderId:order.id, aiId:order.aiId,
        observedAt, reason:'WALLET_LIQUIDATED'});
      continue;
    }
    const quote = accepted.get(order.symbol);
    // A late delivery can carry a trade from before this order's eligible window.
    const target = order.mockForecast && dateMs(order.mockForecast.targetAt);
    const inWindow = target === undefined || (order.action === 'CLOSE'
      ? quote?.trade === target
      : time < target && now < target && quote?.trade < target);
    if (!quote || !inWindow || quote.trade <= dateMs(order.receivedAt) ||
        (interval !== undefined && quote.trade < dateMs(order.eligibleAt))) {
      remaining.push(order);
      continue;
    }
    const observedPrice = quote.price;
    let realizedPnl;
    if (order.action === 'CLOSE') {
      const pos = wallet.position;
      if (!pos || pos.symbol !== order.symbol) {
        next.journal.push({kind:'CANCELLED', orderId:order.id, aiId:order.aiId,
          observedAt, reason:'POSITION_NOT_FOUND'});
        continue;
      }
      realizedPnl = positionPnl(pos, observedPrice);
      const proceeds = pos.margin + realizedPnl;
      wallet.cash = Math.max(0, wallet.cash + proceeds);
      wallet.position = null;
    } else {
      if (wallet.position || order.margin > wallet.cash) {
        next.journal.push({kind:'CANCELLED', orderId:order.id, aiId:order.aiId,
          observedAt, reason:'INSUFFICIENT_FUNDS_OR_POSITION'});
        continue;
      }
      const units = order.margin * order.leverage / observedPrice;
      if (!Number.isFinite(units) || units > Number.MAX_SAFE_INTEGER / 100) {
        fail('保有数量が安全に計算できる数値範囲を超えています');
      }
      wallet.cash -= order.margin;
      wallet.position = {
        symbol: order.symbol,
        direction: order.action === 'OPEN_LONG' ? 'LONG' : 'SHORT',
        margin: order.margin,
        leverage: order.leverage,
        units,
        entryPrice: observedPrice,
        lastPrice: observedPrice,
        openedAt: observedAt,
        modelHash: wallet.modelHash,
      };
    }
    next.journal.push({
      kind: order.action === 'CLOSE' ? 'CLOSED' : 'OPENED',
      orderId: order.id, aiId: order.aiId, modelHash: wallet.modelHash,
      ...eventObservation(quote, order.symbol, observedAt, sourceId),
      ...(market ? {receivedAt: order.receivedAt} : {}),
      ...(interval === undefined ? {} : {eligibleAt: order.eligibleAt}),
      ...(order.mockForecast ? {mockForecast:order.mockForecast} : {}),
      ...(order.mockForecast && order.action === 'CLOSE' ? {realizedPnl} : {}),
    });
  }
  next.pending = remaining;
  return next;
}

export function inspectForwardWallet(ledger, aiId) {
  if (!ledgerMode(ledger?.mode)) fail('仮想取引台帳が不正です');
  const wallet = walletOf(ledger, aiId);
  return {
    status: wallet.status, initial: wallet.initial,
    cash: wallet.cash, equity: Math.max(0, walletEquity(wallet)),
    position: wallet.position ? {...wallet.position} : null,
  };
}
