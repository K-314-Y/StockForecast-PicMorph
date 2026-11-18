/**
 * Forward-looking virtual-paper ledger core. No network calls, broker access,
 * persistence, live-data claims, server route or user-facing money.
 * ONLY a trusted server-side market adapter may supply observations/timestamps.
 * One open position per AI wallet in this first, intentionally isolated seam.
 */
export const FORWARD_PAPER_MODE = 'FORWARD_PAPER_CORE_UNCONNECTED';
const MAX_MEDALS = 1_000_000_000_000;
const MAX_PRICE = 1_000_000_000;
const AI_ID = /^[a-z][a-z0-9_-]{1,39}$/;
const SYMBOL = /^[0-9A-Z]{4,5}$/;
const HASH = /^[a-f0-9]{64}$/;
const ORDER_ID = /^[a-zA-Z0-9_-]{1,60}$/;
const EPS = 1e-8;

const fail = message => { throw new RangeError(message); };
function medals(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) ||
      value > MAX_MEDALS) fail(name + ' が不正です');
  return value;
}
function dateMs(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0,10) !== value.slice(0,10)) {
    fail('時刻は有効なUTC日時で指定してください');
  }
  return Date.parse(value);
}
function price(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      value < 0.000001 || value > MAX_PRICE) fail('市場価格が不正です');
  return value;
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

/**
 * All medals are virtual. Allocation never increases total starting balance.
 * Model versions are frozen identifiers so an edited character starts a new AI.
 */
export function createForwardLedger({initialMedals, allocations}) {
  medals(initialMedals, '開始メダル');
  if (!Array.isArray(allocations) || allocations.length < 1 ||
      allocations.length > 50) fail('AIの配分が不正です');
  const wallets = Object.create(null);
  let assigned = 0;
  for (const item of allocations) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !AI_ID.test(item.id) || !HASH.test(item.modelHash) ||
        Object.hasOwn(wallets, item.id)) fail('AIの識別情報が不正です');
    const amount = medals(item.medals, 'AIへの配分');
    assigned += amount;
    if (assigned > initialMedals) fail('配分が所持メダルを超えています');
    wallets[item.id] = {
      modelHash: item.modelHash, initial: amount, cash: amount,
      position: null, status: 'ACTIVE',
    };
  }
  return {
    mode: FORWARD_PAPER_MODE,
    initialMedals,
    unallocated: initialMedals - assigned,
    wallets,
    pending: [],
    journal: [],
    lastBatchAt: null,
  };
}

/**
 * receivedAt MUST be stamped by the trusted server, never the player/client.
 * The order cannot be filled at an observation that already occurred.
 * In this first slice, one active or pending order is allowed per AI.
 */
export function queueForwardOrder(ledger, order, receivedAt) {
  if (ledger?.mode !== FORWARD_PAPER_MODE || !order ||
      typeof order !== 'object' || Array.isArray(order)) fail('注文データが不正です');
  const stamp = dateMs(receivedAt);
  if (ledger.lastBatchAt !== null && stamp <= dateMs(ledger.lastBatchAt)) {
    fail('過去の時刻では注文できません');
  }
  if (!ORDER_ID.test(order.id) || !SYMBOL.test(order.symbol) ||
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
    ...(order.action === 'CLOSE' ? {} :
      {margin: order.margin, leverage: order.leverage}),
  });
  return next;
}

/**
 * Quotes are INTERNAL inputs from a future trusted adapter, not an API request.
 * Tests use synthetic fixtures; this does NOT connect to any actual market.
 * Missing prices defer orders and leave risk unobservable: production must
 * explicitly handle feed outages rather than inventing a price.
 */
export function applyForwardBatch(ledger, {observedAt, sourceId, quotes}) {
  if (ledger?.mode !== FORWARD_PAPER_MODE) fail('仮想取引台帳が不正です');
  const time = dateMs(observedAt);
  if (ledger.lastBatchAt !== null && time <= dateMs(ledger.lastBatchAt)) {
    fail('市場観測は必ず時系列順に処理してください');
  }
  if (typeof sourceId !== 'string' || !/^[A-Z0-9_]{3,40}$/.test(sourceId) ||
      !quotes || typeof quotes !== 'object' || Array.isArray(quotes) ||
      Object.keys(quotes).length > 200) fail('観測元または銘柄一覧が不正です');
  for (const [symbol, amount] of Object.entries(quotes)) {
    if (!SYMBOL.test(symbol)) fail('銘柄コードが不正です');
    price(amount);
  }
  const next = structuredClone(ledger);
  next.lastBatchAt = observedAt;
  // Mark all held positions before any new orders. A cash gap cannot erase
  // losses, and another AI wallet can never be used as collateral.
  for (const [aiId, wallet] of Object.entries(next.wallets)) {
    const position = wallet.position;
    if (!position || !Object.hasOwn(quotes, position.symbol)) continue;
    position.lastPrice = quotes[position.symbol];
    if (walletEquity(wallet) <= EPS) {
      wallet.cash = 0;
      wallet.position = null;
      wallet.status = 'LIQUIDATED';
      next.journal.push({
        kind: 'LIQUIDATED', aiId, modelHash: wallet.modelHash,
        observedAt, sourceId, price: quotes[position.symbol],
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
    // The observation must be strictly later than order reception.
    if (dateMs(order.receivedAt) >= time ||
        !Object.hasOwn(quotes, order.symbol)) {
      remaining.push(order);
      continue;
    }
    const observedPrice = quotes[order.symbol];
    if (order.action === 'CLOSE') {
      const pos = wallet.position;
      if (!pos || pos.symbol !== order.symbol) {
        next.journal.push({kind:'CANCELLED', orderId:order.id, aiId:order.aiId,
          observedAt, reason:'POSITION_NOT_FOUND'});
        continue;
      }
      const proceeds = pos.margin + positionPnl(pos, observedPrice);
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
      observedAt, sourceId, price: observedPrice,
    });
  }
  next.pending = remaining;
  return next;
}

export function inspectForwardWallet(ledger, aiId) {
  if (ledger?.mode !== FORWARD_PAPER_MODE) fail('仮想取引台帳が不正です');
  const wallet = walletOf(ledger, aiId);
  return {
    status: wallet.status, initial: wallet.initial,
    cash: wallet.cash, equity: Math.max(0, walletEquity(wallet)),
    position: wallet.position ? {...wallet.position} : null,
  };
}
