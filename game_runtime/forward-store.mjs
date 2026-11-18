import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, realpath, rename, rmdir, unlink} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  FORWARD_PAPER_MODE, applyForwardBatch, createForwardLedger,
  inspectForwardWallet, queueForwardOrder,
} from './forward-paper.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIRECTORY = join(ROOT, 'local_state');
const DEFAULT_DIRECTORY = join(STATE_DIRECTORY, 'node_game');
const DEFAULT_FILE = join(DEFAULT_DIRECTORY, 'forward-ledger.json');
const VERSION = 1;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MEDALS = 1_000_000_000_000;
const MAX_BALANCE = Number.MAX_SAFE_INTEGER / 100;
const AI_ID = /^[a-z][a-z0-9_-]{1,39}$/;
const SYMBOL = /^[0-9A-Z]{4,5}$/;
const HASH = /^[a-f0-9]{64}$/;
const ORDER_ID = /^[a-zA-Z0-9_-]{1,60}$/;
const SOURCE_ID = /^[A-Z0-9_]{3,40}$/;
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
const price = value => amount(value, 0.000001, 1_000_000_000);

function timestamp(value) {
  requireValid(matches(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/), 'UTC日時');
  const time = Date.parse(value);
  requireValid(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value.slice(0, 10),
    'UTC日時');
  return time;
}

function validatePosition(position, wallet, lastBatch) {
  requireValid(fields(position, 'symbol', 'direction', 'margin', 'leverage', 'units',
    'entryPrice', 'lastPrice', 'openedAt', 'modelHash'), '保有ポジション');
  requireValid(matches(position.symbol, SYMBOL) && ['LONG', 'SHORT'].includes(position.direction) &&
    integer(position.margin, 1, MAX_MEDALS) && integer(position.leverage, 1, 25) &&
    amount(position.units, Number.MIN_VALUE, MAX_BALANCE) &&
    price(position.entryPrice) && price(position.lastPrice) &&
    position.units === position.margin * position.leverage / position.entryPrice &&
    position.modelHash === wallet.modelHash && timestamp(position.openedAt) <= lastBatch, '保有ポジション');
}

function validatePending(pending, wallets, orderIds) {
  const aiIds = new Set();
  for (const order of pending) {
    const close = order?.action === 'CLOSE';
    const extra = close ? [] : ['margin', 'leverage'];
    requireValid(fields(order, 'id', 'aiId', 'symbol', 'action', 'receivedAt', ...extra) &&
      matches(order.id, ORDER_ID) && !orderIds.has(order.id) &&
      matches(order.aiId, AI_ID) && Object.hasOwn(wallets, order.aiId) && !aiIds.has(order.aiId) &&
      matches(order.symbol, SYMBOL), '予約注文');
    const wallet = wallets[order.aiId];
    requireValid(wallet.status === 'ACTIVE', '予約注文の財布');
    if (close) {
      requireValid(wallet.position?.symbol === order.symbol, '決済注文');
    } else {
      requireValid(['OPEN_LONG', 'OPEN_SHORT'].includes(order.action) && wallet.position === null &&
        integer(order.margin, 1, MAX_MEDALS) && order.margin <= wallet.cash &&
        integer(order.leverage, 1, 25), '新規注文');
    }
    timestamp(order.receivedAt);
    orderIds.add(order.id);
    aiIds.add(order.aiId);
  }
}

function validateJournal(journal, wallets, lastBatch, orderIds) {
  let previous = -Infinity;
  for (const event of journal) {
    requireValid(record(event) && matches(event.aiId, AI_ID) &&
      Object.hasOwn(wallets, event.aiId), '取引履歴の財布');
    const time = timestamp(event.observedAt);
    requireValid(time >= previous && time <= lastBatch, '取引履歴の観測順序');
    previous = time;

    const base = ['kind', 'aiId', 'observedAt'];
    const observation = ['modelHash', 'sourceId', 'price'];
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
        fields(event, ...base, 'orderId', ...observation), '約定履歴');
    }
    requireValid(event.modelHash === wallets[event.aiId].modelHash &&
      matches(event.sourceId, SOURCE_ID) && price(event.price), '取引履歴の観測');
  }
}

function validateLedger(ledger) {
  requireValid(fields(ledger, 'mode', 'initialMedals', 'unallocated', 'wallets', 'pending', 'journal',
    'lastBatchAt') && ledger.mode === FORWARD_PAPER_MODE &&
    integer(ledger.initialMedals, 1, MAX_MEDALS) && integer(ledger.unallocated, 0, MAX_MEDALS) &&
    record(ledger.wallets) && Array.isArray(ledger.pending) && Array.isArray(ledger.journal), '形式');
  const wallets = Object.entries(ledger.wallets);
  requireValid(wallets.length >= 1 && wallets.length <= 50 && ledger.pending.length <= wallets.length,
    '財布・予約注文の件数');
  const lastBatch = ledger.lastBatchAt === null ? -Infinity : timestamp(ledger.lastBatchAt);
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
  const orderIds = new Set();
  validatePending(ledger.pending, ledger.wallets, orderIds);
  validateJournal(ledger.journal, ledger.wallets, lastBatch, orderIds);
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

async function writeSnapshot(filePath, {revision, ledger}) {
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

function withLedgerLock(filePath, operation) {
  const lockPath = filePath + '.lock';
  const running = (operations.get(filePath) ?? Promise.resolve()).then(async () => {
    const directory = dirname(filePath);
    const canonical = await realpath(directory).catch(error => {
      if (filePath === DEFAULT_FILE && error.code === 'ENOENT') throw uninitialized();
      throw error;
    });
    requireValid(canonical === directory, '保存先ディレクトリ種別');
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

/**
 * Virtual ledger for internal server callers on a local filesystem. An optional
 * filePath for tests requires an existing parent. Pass initial ({initialMedals,
 * allocations}) only to create a ledger. Snapshots include a revision, starting at 0.
 *
 * receivedAt is assigned by the caller's trusted server clock. Only an injected
 * getObservation() supplies batches. It must return real observations for live
 * use, and must not call the same store while the transaction holds the lock.
 *
 * Across processes, a busy lock fails immediately. After an abnormal exit a lock
 * may remain. Remove it manually only after stopping every writer and checking
 * the saved file and any orphaned temporary files. Use the same path in each process.
 * After a replacement with uncertain durability, reopen and inspect the revision
 * before retrying. The format retains IDs and stops at 4 MiB without pruning.
 */
export async function openForwardStore({filePath = DEFAULT_FILE, initial, getObservation} = {}) {
  filePath = resolve(filePath);
  const directory = dirname(filePath);
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
      await syncDirectory(directory);
      return;
    }
    if (initial === undefined) throw uninitialized();
    requireValid(fields(initial, 'initialMedals', 'allocations') && Array.isArray(initial.allocations) &&
      initial.allocations.every(item => fields(item, 'id', 'modelHash', 'medals') &&
        matches(item.id, AI_ID) && matches(item.modelHash, HASH)), '初期メダル配分');
    await writeSnapshot(filePath, {revision: 0, ledger: createForwardLedger(initial)});
  });

  function update(expectedRevision, transition) {
    return withLedgerLock(filePath, async () => {
      const current = await readExisting();
      if (expectedRevision !== current.revision) {
        throw storeError('FORWARD_STORE_REVISION_CONFLICT', '仮想台帳の期待 revision が一致しません');
      }
      requireValid(current.revision < Number.MAX_SAFE_INTEGER, 'revision の上限');
      const ledger = await transition(current.ledger);
      const next = {revision: current.revision + 1, ledger};
      await writeSnapshot(filePath, next);
      return next;
    });
  }

  return {
    snapshot: () => withLedgerLock(filePath, readExisting),
    queueForwardOrder: (order, receivedAt, expectedRevision) => update(expectedRevision, ledger =>
      queueForwardOrder(ledger, order, receivedAt)),
    applyForwardBatch: expectedRevision => update(expectedRevision, async ledger => {
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
