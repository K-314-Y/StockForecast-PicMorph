import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath, rename, rmdir, unlink} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {identifyForwardAppearanceModel} from './appearance-model.mjs';
import {getForwardMarketAdapter} from './forward-market-adapter.mjs';
import {
  FORWARD_AI_ID as AI_ID, FORWARD_PAPER_MODE, MAX_FORWARD_MEDALS as MAX_MEDALS, MAX_FORWARD_WALLETS,
  allocateForwardWallet, applyForwardBatch, createForwardLedger,
  inspectForwardWallet, queueForwardOrder,
} from './forward-paper.mjs';
import {
  MARKET_SOURCE_ID, MARKET_SYMBOL, MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE, TEST_FIXTURE_SOURCE,
  isEvidenceText, isMarketMode, isMarketPrice, isObservationInterval, nextObservation, utcTime,
} from './forward-market-guard.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIRECTORY = join(ROOT, 'local_state');
const DEFAULT_DIRECTORY = join(STATE_DIRECTORY, 'node_game');
const DEFAULT_FILE = join(DEFAULT_DIRECTORY, 'forward-ledger.json');
const VERSION = 1;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_BALANCE = Number.MAX_SAFE_INTEGER / 100;
const HASH = /^[a-f0-9]{64}$/;
const ORDER_ID = /^[a-zA-Z0-9_-]{1,60}$/;
const operations = new Map();
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

function storeError(code, message, cause) {
  return Object.assign(new Error(message, {cause}), {code});
}

function requireValid(condition, field) {
  if (!condition) throw new RangeError(`仮想台帳の ${field} が不正です`);
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, ...keys) => record(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const amount = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

function timestamp(value) {
  const time = utcTime(value);
  requireValid(Number.isFinite(time), 'UTC日時');
  return time;
}

function validatePosition(position, wallet, lastBatch) {
  requireValid(fields(position, 'symbol', 'direction', 'margin', 'leverage', 'units',
    'entryPrice', 'lastPrice', 'openedAt', 'modelHash'), '保有ポジション');
  requireValid(matches(position.symbol, MARKET_SYMBOL) && ['LONG', 'SHORT'].includes(position.direction) &&
    integer(position.margin, 1, MAX_MEDALS) && integer(position.leverage, 1, 25) &&
    amount(position.units, Number.MIN_VALUE, MAX_BALANCE) &&
    isMarketPrice(position.entryPrice) && isMarketPrice(position.lastPrice) &&
    position.units === position.margin * position.leverage / position.entryPrice &&
    position.modelHash === wallet.modelHash && timestamp(position.openedAt) <= lastBatch, '保有ポジション');
}

function validateMockForecast(binding, mode, interval) {
  requireValid(mode === MOCK_MARKET_PAPER_MODE && interval !== undefined &&
    fields(binding, 'forecastSha256', 'targetAt', 'reference') &&
    matches(binding.forecastSha256, HASH) && Number.isFinite(utcTime(binding.targetAt)) &&
    fields(binding.reference, 'raw', 'proof') && isEvidenceText(binding.reference.raw, 16_384) &&
    isEvidenceText(binding.reference.proof, 4096), 'MOCK_NONLIVE 予測証拠');
}

function validatePending(pending, wallets, orderIds, interval, mode) {
  const aiIds = new Set();
  for (const order of pending) {
    const close = order?.action === 'CLOSE';
    const extra = close ? [] : ['margin', 'leverage'];
    requireValid(fields(order, 'id', 'aiId', 'symbol', 'action', 'receivedAt',
      ...(interval === undefined ? [] : ['eligibleAt']),
      ...(order && Object.hasOwn(order, 'mockForecast') ? ['mockForecast'] : []), ...extra) &&
      matches(order.id, ORDER_ID) && !orderIds.has(order.id) &&
      matches(order.aiId, AI_ID) && Object.hasOwn(wallets, order.aiId) && !aiIds.has(order.aiId) &&
      matches(order.symbol, MARKET_SYMBOL), '予約注文');
    const wallet = wallets[order.aiId];
    requireValid(wallet.status === 'ACTIVE', '予約注文の財布');
    if (close) {
      requireValid(wallet.position?.symbol === order.symbol, '決済注文');
    } else {
      requireValid(['OPEN_LONG', 'OPEN_SHORT'].includes(order.action) && wallet.position === null &&
        integer(order.margin, 1, MAX_MEDALS) && order.margin <= wallet.cash &&
        integer(order.leverage, 1, 25), '新規注文');
    }
    const received = timestamp(order.receivedAt);
    if (interval !== undefined) {
      requireValid(timestamp(order.eligibleAt) === nextObservation(received, interval), '予約注文の締切');
    }
    if (Object.hasOwn(order, 'mockForecast')) {
      validateMockForecast(order.mockForecast, mode, interval);
      const target = timestamp(order.mockForecast.targetAt);
      const eligible = timestamp(order.eligibleAt);
      requireValid(received < target && (close ? eligible <= target : eligible < target), 'MOCK_NONLIVE 予測注文の締切');
    }
    orderIds.add(order.id);
    aiIds.add(order.aiId);
  }
}

function validateJournal(ledger, lastBatch, orderIds) {
  const {journal, wallets, lastTradeAt, observationIntervalMs: interval} = ledger;
  let previous = -Infinity;
  for (const event of journal) {
    requireValid(record(event) && matches(event.aiId, AI_ID) &&
      Object.hasOwn(wallets, event.aiId), '取引履歴の財布');
    const time = timestamp(event.observedAt);
    requireValid(time >= previous && time <= lastBatch, '取引履歴の観測順序');
    previous = time;

    const base = ['kind', 'aiId', 'observedAt'];
    const observation = ['modelHash', 'sourceId', 'price'];
    if (lastTradeAt) observation.push('symbol', 'tradeAt', 'publishedAt', 'ingestedAt');
    if (interval !== undefined) observation.push('evidence');
    if (event.kind === 'LIQUIDATED') {
      requireValid(fields(event, ...base, ...observation), '強制決済履歴');
    } else {
      requireValid(matches(event.orderId, ORDER_ID) && !orderIds.has(event.orderId), '取引履歴の注文ID');
      orderIds.add(event.orderId);
      if (event.kind === 'CANCELLED') {
        requireValid(fields(event, ...base, 'orderId', 'reason') &&
          ['WALLET_LIQUIDATED', 'POSITION_NOT_FOUND', 'INSUFFICIENT_FUNDS_OR_POSITION'].includes(event.reason),
        '取消履歴');
        continue;
      }
      requireValid(['OPENED', 'CLOSED'].includes(event.kind) &&
        fields(event, ...base, 'orderId', ...observation, ...(lastTradeAt ? ['receivedAt'] : []),
          ...(interval === undefined ? [] : ['eligibleAt']),
          ...(Object.hasOwn(event, 'mockForecast') ? ['mockForecast',
            ...(event.kind === 'CLOSED' ? ['realizedPnl'] : [])] : [])), '約定履歴');
      if (Object.hasOwn(event, 'mockForecast')) {
        validateMockForecast(event.mockForecast, ledger.mode, interval);
        const target = timestamp(event.mockForecast.targetAt);
        requireValid(event.kind === 'OPENED' ? time < target :
          timestamp(event.tradeAt) === target && amount(event.realizedPnl, -MAX_BALANCE, MAX_BALANCE),
        'MOCK_NONLIVE 予測約定');
      }
    }
    requireValid(event.modelHash === wallets[event.aiId].modelHash &&
      matches(event.sourceId, MARKET_SOURCE_ID) && isMarketPrice(event.price), '取引履歴の観測');
    if (lastTradeAt) {
      const trade = timestamp(event.tradeAt);
      const published = timestamp(event.publishedAt);
      const ingested = timestamp(event.ingestedAt);
      requireValid(event.sourceId !== TEST_FIXTURE_SOURCE && matches(event.symbol, MARKET_SYMBOL) &&
        Object.hasOwn(lastTradeAt, event.symbol) &&
        trade <= timestamp(lastTradeAt[event.symbol]) &&
        trade <= published && published <= ingested && ingested <= time &&
        (event.kind === 'LIQUIDATED' || timestamp(event.receivedAt) < trade), '取引履歴の市場時刻');
    }
    if (interval !== undefined) {
      const {evidence} = event;
      requireValid((ledger.mode === MOCK_MARKET_PAPER_MODE) === (event.sourceId === MOCK_MARKET_SOURCE) &&
        fields(evidence, 'market', 'valueKind', 'raw', 'proof', 'licenseRef') &&
        evidence.market === 'XTKS' && evidence.valueKind === 'TRADE' &&
        isEvidenceText(evidence.raw, 16_384) && isEvidenceText(evidence.proof, 4096) &&
        evidence.proof !== TEST_FIXTURE_SOURCE && isEvidenceText(evidence.licenseRef, 256) &&
        timestamp(event.ingestedAt) === time, '取引履歴の出典');
      if (event.kind !== 'LIQUIDATED') {
        const eligible = timestamp(event.eligibleAt);
        requireValid(eligible === nextObservation(timestamp(event.receivedAt), interval) &&
          eligible <= timestamp(event.tradeAt), '約定履歴の締切');
      }
    }
  }
}

function validateAppearanceGenerations(generations, wallets) {
  requireValid(Array.isArray(generations) && generations.length > 0 &&
    generations.length <= Object.keys(wallets).length, '外見モデルの世代数');
  const ids = new Set();
  let previousSettings;
  for (const generation of generations) {
    requireValid(fields(generation, 'aiId', 'model_version', 'model') && matches(generation.aiId, AI_ID) &&
      Object.hasOwn(wallets, generation.aiId) && !ids.has(generation.aiId), '外見モデルのAI ID');
    const {model, modelHash} = identifyForwardAppearanceModel(generation);
    const settings = JSON.stringify(model);
    requireValid(modelHash === wallets[generation.aiId].modelHash && settings !== previousSettings, '外見モデルの設定');
    ids.add(generation.aiId);
    previousSettings = settings;
  }
}

function validateLedger(ledger) {
  const market = isMarketMode(ledger?.mode);
  const scheduled = record(ledger) && Object.hasOwn(ledger, 'observationIntervalMs');
  const hasGenerations = record(ledger) && Object.hasOwn(ledger, 'appearanceGenerations');
  requireValid(fields(ledger, 'mode', 'initialMedals', 'unallocated', 'wallets', 'pending', 'journal',
    'lastBatchAt', ...(market ? ['lastTradeAt'] : []), ...(scheduled ? ['observationIntervalMs'] : []),
    ...(hasGenerations ? ['appearanceGenerations'] : [])) &&
    (market || ledger.mode === FORWARD_PAPER_MODE) &&
    (!scheduled || (market && isObservationInterval(ledger.observationIntervalMs))) &&
    (ledger.mode !== MOCK_MARKET_PAPER_MODE || scheduled) &&
    integer(ledger.initialMedals, 1, MAX_MEDALS) && integer(ledger.unallocated, 0, MAX_MEDALS) &&
    record(ledger.wallets) && Array.isArray(ledger.pending) && Array.isArray(ledger.journal), '形式');
  const wallets = Object.entries(ledger.wallets);
  requireValid(wallets.length >= 1 && wallets.length <= MAX_FORWARD_WALLETS && ledger.pending.length <= wallets.length,
    '財布・予約注文の件数');
  const lastBatch = ledger.lastBatchAt === null ? -Infinity : timestamp(ledger.lastBatchAt);
  if (market) {
    requireValid(record(ledger.lastTradeAt), '銘柄別の最新市場時刻');
    for (const [symbol, at] of Object.entries(ledger.lastTradeAt)) {
      requireValid(matches(symbol, MARKET_SYMBOL) && timestamp(at) <= lastBatch, '銘柄別の最新市場時刻');
    }
  }
  let allocated = ledger.unallocated;
  for (const [aiId, wallet] of wallets) {
    requireValid(matches(aiId, AI_ID) && fields(wallet, 'modelHash', 'initial', 'cash', 'position', 'status') &&
      matches(wallet.modelHash, HASH) && integer(wallet.initial, 1, MAX_MEDALS) &&
      amount(wallet.cash, 0, MAX_BALANCE) && ['ACTIVE', 'LIQUIDATED'].includes(wallet.status), '財布');
    if (wallet.status === 'LIQUIDATED') {
      requireValid(wallet.cash === 0 && wallet.position === null && ledger.lastBatchAt !== null, '強制決済済みの財布');
    }
    if (wallet.position !== null) {
      validatePosition(wallet.position, wallet, lastBatch);
      requireValid(inspectForwardWallet(ledger, aiId).equity > 0, '評価残高');
    }
    allocated += wallet.initial;
  }
  requireValid(allocated === ledger.initialMedals, '開始メダル配分');
  if (hasGenerations) validateAppearanceGenerations(ledger.appearanceGenerations, ledger.wallets);
  const orderIds = new Set();
  validatePending(ledger.pending, ledger.wallets, orderIds, ledger.observationIntervalMs, ledger.mode);
  validateJournal(ledger, lastBatch, orderIds);
}

function encode(revision, ledger) {
  const payload = {version: VERSION, revision, ledger};
  // Unkeyed checksum for accidental corruption only. A local editor can recompute it.
  const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return JSON.stringify({...payload, checksum}) + '\n';
}

async function readSnapshot(filePath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    throw storeError('FORWARD_STORE_CORRUPT', '仮想台帳の保存ファイル種別またはリンク数が不正です');
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code !== 'ELOOP') throw error;
    throw storeError('FORWARD_STORE_CORRUPT', '仮想台帳の保存ファイル種別が不正です', error);
  }
  try {
    const opened = await handle.stat();
    const {size, nlink} = opened;
    requireValid(opened.isFile() && nlink === 1, '保存ファイル種別・リンク数');
    requireValid(size > 0 && size <= MAX_BYTES, '保存ファイルのサイズ');
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    requireValid(length === size, '保存ファイルのサイズ');
    const content = decoder.decode(buffer.subarray(0, length));
    const saved = JSON.parse(content);
    requireValid(fields(saved, 'version', 'revision', 'ledger', 'checksum') && saved.version === VERSION &&
      integer(saved.revision, 0, Number.MAX_SAFE_INTEGER), '保存形式・revision');
    validateLedger(saved.ledger);
    // Requiring the writer's exact encoding also rejects repeated JSON keys.
    requireValid(content === encode(saved.revision, saved.ledger), '保存形式・チェックサム');
    return {revision: saved.revision, ledger: saved.ledger};
  } catch (error) {
    throw storeError('FORWARD_STORE_CORRUPT', '仮想台帳の保存ファイルを検証できません', error);
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeSnapshot(filePath, {revision, ledger}, beforeCommit) {
  validateLedger(ledger);
  const content = encode(revision, ledger);
  if (Buffer.byteLength(content) > MAX_BYTES) {
    throw storeError('FORWARD_STORE_TOO_LARGE', '仮想台帳が保存上限を超えています');
  }
  const directory = dirname(filePath);
  const temporary = join(directory, `.forward-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  let renamed = false;
  try {
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (beforeCommit) await beforeCommit();
    await rename(temporary, filePath);
    renamed = true;
    await syncDirectory(directory);
  } catch (error) {
    if (renamed) {
      throw storeError('FORWARD_STORE_COMMIT_UNCERTAIN',
        '仮想台帳の置換後に永続化を確認できません。再オープンして revision を確認してください', error);
    }
    throw error;
  } finally {
    if (!renamed) await unlink(temporary).catch(() => {});
  }
}

async function checkLedgerDirectory(directory, allowMissingParent) {
  let candidate = directory;
  for (;;) {
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      const parent = dirname(candidate);
      if (!allowMissingParent || error.code !== 'ENOENT' || parent === candidate) throw error;
      candidate = parent;
      continue;
    }
    // A missing descendant of a symlink is an invalid path, too.
    requireValid(info.isDirectory() && await realpath(candidate) === candidate, '保存先ディレクトリ種別');
    if (candidate !== directory) throw uninitialized();
    return;
  }
}

/** Read one validated atomic snapshot without creating a ledger or taking a write lock. */
export async function readForwardSnapshot(filePath) {
  filePath = resolve(filePath);
  await checkLedgerDirectory(dirname(filePath), true);
  const current = await readSnapshot(filePath);
  if (current === null) throw uninitialized();
  return current;
}

function withLedgerLock(filePath, operation, {allowMissingParent = false} = {}) {
  const lockPath = filePath + '.lock';
  const running = (operations.get(filePath) ?? Promise.resolve()).then(async () => {
    await checkLedgerDirectory(dirname(filePath), allowMissingParent);
    try {
      await mkdir(lockPath, {mode: 0o700});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw storeError('FORWARD_STORE_LOCKED', '仮想台帳は別プロセスが使用中か、ロックが残っています', error);
    }
    let result;
    try {
      result = await operation();
    } catch (error) {
      try {
        await rmdir(lockPath);
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], '仮想台帳の操作とロック解除に失敗しました');
      }
      throw error;
    }
    try {
      await rmdir(lockPath);
    } catch (error) {
      throw storeError('FORWARD_STORE_LOCK_RELEASE_FAILED',
        '仮想台帳のロックを解除できません。復旧後、再オープンして revision を確認してください', error);
    }
    return result;
  });
  const tail = running.catch(() => {});
  operations.set(filePath, tail);
  return running.finally(() => {
    if (operations.get(filePath) === tail) operations.delete(filePath);
  });
}

async function prepareDefaultDirectory() {
  for (const directory of [STATE_DIRECTORY, DEFAULT_DIRECTORY]) {
    try {
      await mkdir(directory, {mode: 0o700});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    requireValid((await lstat(directory)).isDirectory(), '保存先ディレクトリ種別');
    // Persist the directory entries too, including one a concurrent initializer just created.
    await syncDirectory(dirname(directory));
  }
}

function uninitialized() {
  return storeError('FORWARD_STORE_UNINITIALIZED', '仮想台帳がありません。初期メダル配分を明示してください');
}

function revisionConflict() {
  return storeError('FORWARD_STORE_REVISION_CONFLICT', '仮想台帳の期待 revision が一致しません');
}

export const APPEARANCE_STARTING_MEDALS = 10_000;

/** Append a frozen model and its funded wallet in one durable commit.
 * beforeCommit may recheck external revisions under the ledger lock.
 */
export async function saveForwardAppearanceGeneration({
  filePath = DEFAULT_FILE, aiId, appearance, medals, expectedRevision, beforeCommit,
}) {
  requireValid(matches(aiId, AI_ID) && integer(medals, 1, MAX_MEDALS), 'AI ID・配分');
  requireValid(expectedRevision === null || integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER), 'revision');
  const {model_version, model, modelHash} = identifyForwardAppearanceModel(appearance);
  filePath = resolve(filePath);
  if (filePath === DEFAULT_FILE && expectedRevision === null) await prepareDefaultDirectory();
  return withLedgerLock(filePath, async () => {
    const current = await readSnapshot(filePath);
    if ((current?.revision ?? null) !== expectedRevision) throw revisionConflict();
    const generations = current?.ledger.appearanceGenerations ?? [];
    const latest = generations.at(-1);
    if (latest && JSON.stringify(identifyForwardAppearanceModel(latest).model) === JSON.stringify(model)) {
      // A previous attempt may have reached rename before reporting an fsync error.
      await syncDirectory(dirname(filePath));
      if (beforeCommit) await beforeCommit();
      return {...current, created: false};
    }
    requireValid(!current || current.revision < Number.MAX_SAFE_INTEGER, 'revision の上限');
    const allocation = {id: aiId, modelHash, medals};
    let ledger;
    try {
      ledger = current ? allocateForwardWallet(current.ledger, allocation) :
        createForwardLedger({initialMedals: APPEARANCE_STARTING_MEDALS, allocations: [allocation]});
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw storeError('FORWARD_STORE_ALLOCATION_REJECTED', error.message, error);
    }
    ledger.appearanceGenerations = [...generations, {aiId, model_version, model}];
    const next = {revision: current ? current.revision + 1 : 0, ledger};
    await writeSnapshot(filePath, next, beforeCommit);
    return {...next, created: true};
  });
}

/**
 * Virtual ledger for internal server callers on a local filesystem. An optional
 * filePath for tests requires an existing parent for writes. Pass initial ({initialMedals,
 * allocations}) only to create a ledger. Snapshots include a revision, starting at 0.
 *
 * The unconnected fixture path takes caller timestamps and getObservation().
 * Market writes require a server-owned adapter and use reserveMarketOrder()
 * for clock-stamped orders. Existing unscheduled market ledgers are readable.
 * Observation callbacks run under the lock and must avoid reentering the store.
 *
 * Across processes, a busy lock fails immediately. After an abnormal exit a lock
 * may remain. Remove it manually only after stopping every writer and checking
 * the saved file and any orphaned temporary files. Use the same path in each process.
 * After a replacement with uncertain durability, reopen and inspect the revision
 * before retrying. The format retains IDs and stops at 4 MiB without pruning.
 */
export async function openForwardStore({
  filePath = DEFAULT_FILE, initial, getObservation, marketAdapter,
} = {}) {
  filePath = resolve(filePath);
  const directory = dirname(filePath);
  const adapter = getForwardMarketAdapter(marketAdapter);
  if ((marketAdapter !== undefined && !adapter) ||
      (adapter?.mode === MOCK_MARKET_PAPER_MODE && filePath === DEFAULT_FILE)) {
    throw new RangeError('市場アダプターまたは保存先が不正です');
  }
  function requireAdapter(ledger) {
    if (!adapter || adapter.mode !== ledger.mode ||
        adapter.observationIntervalMs !== ledger.observationIntervalMs) {
      throw new RangeError('市場観測元の利用許可または台帳の観測間隔を確認できません');
    }
  }
  if (initial !== undefined && (adapter || isMarketMode(initial?.mode))) {
    requireAdapter({mode: initial?.mode, observationIntervalMs: adapter?.observationIntervalMs});
    adapter.authorize();
  }
  if (filePath === DEFAULT_FILE && initial !== undefined) await prepareDefaultDirectory();

  async function readExisting() {
    const current = await readSnapshot(filePath);
    if (current === null) throw uninitialized();
    return current;
  }

  await withLedgerLock(filePath, async () => {
    const current = await readSnapshot(filePath);
    if (current !== null) {
      if (initial !== undefined) {
        throw storeError('FORWARD_STORE_ALREADY_INITIALIZED', '保存済みの仮想台帳は初期化できません');
      }
      if (adapter) requireAdapter(current.ledger);
      await syncDirectory(directory);
      return;
    }
    if (initial === undefined) throw uninitialized();
    requireValid((fields(initial, 'initialMedals', 'allocations') ||
      fields(initial, 'initialMedals', 'allocations', 'mode')) && Array.isArray(initial.allocations) &&
      initial.allocations.every(item => fields(item, 'id', 'modelHash', 'medals') &&
        matches(item.id, AI_ID) && matches(item.modelHash, HASH)), '初期メダル配分');
    const ledger = createForwardLedger(initial);
    if (adapter) ledger.observationIntervalMs = adapter.observationIntervalMs;
    await writeSnapshot(filePath, {revision: 0, ledger});
  }, {allowMissingParent: initial === undefined});

  function update(expectedRevision, transition, beforeCommit) {
    return withLedgerLock(filePath, async () => {
      const current = await readExisting();
      if (expectedRevision !== current.revision) throw revisionConflict();
      requireValid(current.revision < Number.MAX_SAFE_INTEGER, 'revision の上限');
      const ledger = await transition(current.ledger);
      const next = {revision: current.revision + 1, ledger};
      await writeSnapshot(filePath, next, beforeCommit);
      return next;
    });
  }

  return {
    snapshot: () => withLedgerLock(filePath, readExisting),
    queueForwardOrder: (order, receivedAt, expectedRevision) => update(expectedRevision, ledger => {
      requireValid(ledger.mode === FORWARD_PAPER_MODE, '予約注文の受付経路');
      return queueForwardOrder(ledger, order, receivedAt);
    }),
    reserveMarketOrder: async (order, expectedRevision) => {
      requireValid(fields(order, 'id', 'aiId', 'symbol', 'action',
        ...(order?.action === 'CLOSE' ? [] : ['margin', 'leverage'])), '予約注文の入力');
      if (!adapter) throw new RangeError('市場観測元の利用許可を確認できません');
      const receivedAt = adapter.stamp();
      const request = structuredClone(order);
      return update(expectedRevision, ledger => {
        requireAdapter(ledger);
        adapter.authorize();
        return queueForwardOrder(ledger, request, receivedAt);
      });
    },
    reserveMockForecastOrder: (order, binding, {notBefore, expectedRevision}) => {
      const request = structuredClone(order);
      const mockForecast = structuredClone(binding);
      const close = request.action === 'CLOSE';
      const cutoff = timestamp(mockForecast.targetAt);
      const earliest = timestamp(notBefore);
      let receivedAt;
      function checkWindow(at) {
        const time = timestamp(at);
        if (!(time >= earliest && time < cutoff)) {
          throw new RangeError('Server receipt is outside the MOCK_NONLIVE forecast window');
        }
      }
      return update(expectedRevision, ledger => {
        requireAdapter(ledger);
        validateMockForecast(mockForecast, ledger.mode, ledger.observationIntervalMs);
        adapter.mockReference(mockForecast.reference, request.symbol);
        receivedAt = adapter.stamp();
        checkWindow(receivedAt);
        const next = queueForwardOrder(ledger, request, receivedAt);
        const pending = next.pending.at(-1);
        const eligible = timestamp(pending.eligibleAt);
        if (close ? eligible > cutoff : eligible >= cutoff) {
          throw new RangeError('No eligible batch before the MOCK_NONLIVE order cutoff');
        }
        pending.mockForecast = mockForecast;
        return next;
      }, () => {
        adapter.authorize();
        const checkedAt = adapter.stamp();
        checkWindow(checkedAt);
        if (timestamp(checkedAt) < timestamp(receivedAt)) {
          throw new RangeError('Server clock reversed during MOCK_NONLIVE reservation');
        }
      });
    },
    applyForwardBatch: expectedRevision => update(expectedRevision, async ledger => {
      if (isMarketMode(ledger.mode)) {
        requireAdapter(ledger);
        const {observation, options} = await adapter.observe();
        const next = applyForwardBatch(ledger, observation, options);
        for (const event of next.journal.slice(ledger.journal.length)) {
          if (event.mockForecast) adapter.mockForecastTrades(event);
        }
        return next;
      }
      if (typeof getObservation !== 'function') {
        throw storeError('FORWARD_STORE_NO_OBSERVATION', '内部の市場観測関数が設定されていません');
      }
      const observation = await getObservation();
      if (observation == null) {
        throw storeError('FORWARD_STORE_NO_OBSERVATION', '内部の市場観測データがありません');
      }
      return applyForwardBatch(ledger, structuredClone(observation));
    }),
  };
}
