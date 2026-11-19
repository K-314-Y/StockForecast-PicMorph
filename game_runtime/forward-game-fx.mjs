import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, open, realpath, unlink} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {mockReferenceSha256} from './forward-market-adapter.mjs';
import {MARKET_SYMBOL, MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE, utcTime} from './forward-market-guard.mjs';
import {getForwardMockRecordContext, mockForecastOrderId} from './forward-mock-lifecycle.mjs';
import {positionPnl} from './forward-paper.mjs';
import {forecastDirection} from './forward-score.mjs';
import {readForwardSnapshot} from './forward-store.mjs';

const RATES = [9800, 9900, 10000, 10100, 10200];
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 8192;
const json = JSON.stringify;
const sha256 = value => createHash('sha256').update(json(value)).digest('hex');
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const fail = message => { throw new RangeError(message); };

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function journal(directory, mac) {
  const pathFor = (kind, id) => join(directory, `p9b-${kind}-${id}.json`);
  const encode = (kind, id, payload) => Buffer.from(json({
    payload, mac:mac(['record', kind, id, payload]),
  }));

  async function read(kind, id) {
    let handle;
    try {
      handle = await open(pathFor(kind, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RECORD_BYTES) fail('Invalid P9b journal file');
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const {bytesRead} = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const {payload} = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      const expected = encode(kind, id, payload);
      if (!payload || length !== stat.size || expected.length !== length ||
          !timingSafeEqual(bytes.subarray(0, length), expected)) fail('Invalid P9b journal authentication');
      return payload;
    } finally {
      await handle.close();
    }
  }

  async function append(kind, id, payload) {
    let saved = await read(kind, id);
    if (saved === null) {
      const path = join(directory, '.p9b-' + randomUUID() + '.tmp');
      const handle = await open(path, 'wx', 0o600);
      try {
        try {
          await handle.writeFile(encode(kind, id, payload));
          await handle.sync();
        } finally {
          await handle.close();
        }
        // The final name is never replaced. A stop after link may leave a
        // second name for the same authenticated, fully synced inode.
        await link(path, pathFor(kind, id)).catch(error => {
          if (error.code !== 'EEXIST') throw error;
        });
      } finally {
        await unlink(path);
      }
      saved = await read(kind, id);
    }
    // Also make a competing publisher's link durable before acknowledging it.
    await syncDirectory(directory);
    if (saved === null) fail('P9b journal record disappeared');
    return saved;
  }

  async function appendExact(kind, id, payload) {
    const saved = await append(kind, id, payload);
    if (json(saved) !== json(payload)) fail('Conflicting P9b journal record');
    return saved;
  }

  return {read, append, appendExact};
}

/**
 * Internal server capability for one account's signed mock lifecycle and one
 * round. Use one dedicated local journal directory and a stable 32-byte key
 * across all account handles/processes. The account and lifecycle source are
 * selected by trusted server code. The optional byte derivation is a test seam
 * and must be deterministic for a round ID and counter.
 *
 * Commit before cutoff, reserve against an already filled P4 position before
 * cutoff, then settle after P4 has closed and scored. This journal is a
 * projection of virtual medal proceeds. It has no spendable balance.
 */
export async function openForwardGameFx({
  journalDirectory, signingKey, accountId, recordSource, symbol, targetAt, deriveRoundBytes,
} = {}) {
  const context = getForwardMockRecordContext(recordSource);
  const cutoff = utcTime(targetAt);
  if (context?.adapter.mode !== MOCK_MARKET_PAPER_MODE ||
      typeof journalDirectory !== 'string' || !journalDirectory.trim() ||
      !Buffer.isBuffer(signingKey) || signingKey.length !== 32 ||
      !matches(accountId, /^[a-zA-Z0-9_-]{1,64}$/) || !matches(symbol, MARKET_SYMBOL) ||
      !Number.isFinite(cutoff) || (deriveRoundBytes !== undefined && typeof deriveRoundBytes !== 'function')) {
    fail('Explicit server account and signed MOCK_NONLIVE FX configuration are required');
  }
  targetAt = new Date(cutoff).toISOString();
  journalDirectory = resolve(journalDirectory);
  if (journalDirectory === context.directory || journalDirectory === dirname(context.walletFile) ||
      !(await lstat(journalDirectory)).isDirectory() || await realpath(journalDirectory) !== journalDirectory) {
    fail('P9b requires a dedicated real local journal directory');
  }

  const {adapter, reference} = context;
  const referenceTrade = adapter.mockReference(reference, symbol);
  if (utcTime(referenceTrade.publishedAt) >= cutoff) fail('MOCK_NONLIVE reference is too late for this round');
  async function readWallet() {
    const {ledger} = await readForwardSnapshot(context.walletFile);
    if (ledger.mode !== MOCK_MARKET_PAPER_MODE || ledger.observationIntervalMs !== adapter.observationIntervalMs) {
      fail('P9b requires a MOCK_NONLIVE ledger');
    }
    return ledger;
  }
  await readWallet();
  const key = Buffer.from(signingKey);
  const mac = value => createHmac('sha256', key).update(json(['P9b/v1', value])).digest('hex');
  const store = journal(journalDirectory, mac);
  const wallet = sha256(context.walletFile);
  const forecasts = sha256(context.directory);
  const owner = {accountId, wallet, forecasts};
  for (const [kind, id] of [['wallet-owner', wallet], ['forecast-owner', forecasts]]) {
    const saved = await store.read(kind, id);
    if (saved && json(saved) !== json(owner)) fail('Conflicting P9b journal account binding');
  }
  await store.appendExact('wallet-owner', wallet, owner);
  await store.appendExact('forecast-owner', forecasts, owner);

  const round = {sourceMode:MOCK_MARKET_SOURCE, market:referenceTrade.market, symbol, targetAt};
  const roundId = sha256(round);
  const referenceSha256 = mockReferenceSha256(reference);
  const roundBinding = {roundId, ...round, referenceSha256};
  const commitmentFor = (basisPoints, nonce) => sha256(['P9b FX commitment/v1', roundBinding, basisPoints, nonce]);

  // A keyed PRF makes concurrent/restarted candidates agree even before a
  // final filename exists. Rejection of byte 255 avoids modulo bias.
  function chooseRate() {
    for (let counter = 0; counter < 128; counter++) {
      const bytes = deriveRoundBytes === undefined ?
        Buffer.from(mac(['draw', roundId, counter]), 'hex') : deriveRoundBytes(roundId, counter);
      if (!Buffer.isBuffer(bytes) || bytes.length !== 32) fail('Invalid server FX random bytes');
      const byte = bytes.find(value => value < 255);
      if (byte !== undefined) return RATES[byte % RATES.length];
    }
    fail('Server FX random bytes exhausted');
  }

  function beforeTarget(earliest) {
    const at = adapter.stamp();
    if (!(utcTime(earliest) <= utcTime(at) && utcTime(at) < cutoff)) {
      fail('P9b commitment or reservation is outside the round cutoff');
    }
    return at;
  }

  function checkConfirmation(proof, record) {
    if (proof && (!record || proof.recordSha256 !== sha256(record) ||
        !(utcTime(record.boundAt) <= utcTime(proof.confirmedAt) && utcTime(proof.confirmedAt) < cutoff))) {
      fail('P9b cutoff proof does not match its record');
    }
    return proof;
  }

  async function readAttestation(kind, id, readDraft) {
    // An immutable proof can only be published after its draft. Read in this
    // order so a concurrent publication cannot look like an orphaned proof.
    const proof = await store.read(kind + '-confirmed', id);
    const record = await readDraft();
    return {record, proof:checkConfirmation(proof, record)};
  }

  async function confirm(kind, id, record) {
    await syncDirectory(journalDirectory);
    const proof = checkConfirmation(await store.read(kind + '-confirmed', id), record);
    if (proof) return proof;
    const candidate = {recordSha256:sha256(record), confirmedAt:beforeTarget(record.boundAt)};
    return checkConfirmation(await store.append(kind + '-confirmed', id, candidate), record);
  }

  async function readRound() {
    const record = await store.read('round', roundId);
    if (record && (!Object.entries(roundBinding).every(([field, value]) => record[field] === value) ||
        !RATES.includes(record.basisPoints) || !matches(record.nonce, HASH) ||
        record.commitment !== commitmentFor(record.basisPoints, record.nonce) ||
        !(utcTime(referenceTrade.publishedAt) <= utcTime(record.boundAt) && utcTime(record.boundAt) < cutoff))) {
      fail('P9b round source, reference or commitment mismatch');
    }
    return record;
  }

  async function load(forecastId) {
    if (!matches(forecastId, HASH)) fail('Invalid P9b forecast ID');
    const saved = await recordSource.read(forecastId);
    if (!saved) fail('No confirmed MOCK_NONLIVE forecast in this account');
    const {forecast, receipt, outcome} = saved;
    if (forecast.sourceMode !== 'TEST_ONLY' || forecast.symbol !== symbol || forecast.targetAt !== targetAt ||
        utcTime(referenceTrade.publishedAt) > utcTime(forecast.issuedAt) ||
        (forecast.provenance.mockReferenceSha256 !== undefined &&
         forecast.provenance.mockReferenceSha256 !== referenceSha256)) {
      fail('P9b forecast source, reference or round mismatch');
    }
    const {ledger} = await recordSource.snapshot(saved);
    if (ledger.mode !== MOCK_MARKET_PAPER_MODE) fail('P9b requires a MOCK_NONLIVE ledger');
    const index = ledger.journal.findIndex(event => event.orderId === mockForecastOrderId(forecastId, 'open'));
    const opened = ledger.journal[index];
    if (opened?.kind !== 'OPENED' || mockReferenceSha256(opened.mockForecast.reference) !== referenceSha256) {
      fail('P9b requires an opened position with the round reference');
    }
    const binding = {roundId, accountId, wallet, forecasts, forecastId, aiId:forecast.aiId,
      forecastSha256:receipt.forecastSha256, receiptSha256:sha256(receipt), openSha256:sha256(opened)};
    return {ledger, forecast, outcome, opened, index, binding};
  }

  async function readReservation(id, binding, roundProof) {
    const record = await store.read('reservation', id);
    if (record && (!Object.entries(binding).every(([field, value]) => record[field] === value) ||
        record.commitment !== roundProof.commitment ||
        !(utcTime(roundProof.confirmedAt) <= utcTime(record.boundAt) && utcTime(record.boundAt) < cutoff))) {
      fail('P9b reservation does not match the round, account or opening fill');
    }
    return record;
  }

  async function requireRound() {
    adapter.authorize();
    const {record, proof} = await readAttestation('round', roundId, readRound);
    if (!proof) fail('P9b round was not confirmed before cutoff');
    return {...record, confirmedAt:proof.confirmedAt};
  }

  return Object.freeze({
    async commitRound(...extra) {
      if (extra.length) fail('The P9b rate is server-owned');
      adapter.authorize();
      const {record:prior, proof} = await readAttestation('round', roundId, readRound);
      if (!proof) {
        const ledger = await readWallet();
        if (utcTime(ledger.lastBatchAt) >= cutoff) fail('P9b round already reached outcome time');
      }
      if (!prior) {
        const boundAt = beforeTarget(referenceTrade.publishedAt);
        const basisPoints = chooseRate();
        const nonce = mac(['nonce', roundId]);
        await store.append('round', roundId, {...roundBinding, boundAt, basisPoints, nonce,
          commitment:commitmentFor(basisPoints, nonce)});
      }
      const record = await readRound();
      const {confirmedAt} = await confirm('round', roundId, record);
      return {...roundBinding, commitment:record.commitment, confirmedAt};
    },

    async reserve(forecastId, ...extra) {
      if (extra.length) fail('P9b reservation uses only verified wallet margin');
      const roundProof = await requireRound();
      const {ledger, forecast, outcome, opened, index, binding} = await load(forecastId);
      const id = sha256([wallet, forecastId]);
      const readDraft = () => readReservation(id, binding, roundProof);
      const {record:prior, proof} = await readAttestation('reservation', id, readDraft);
      if (!proof && (outcome || utcTime(ledger.lastBatchAt) >= cutoff)) {
        fail('P9b reservation cannot be confirmed after outcome time');
      }
      if (!prior) {
        const position = ledger.wallets[forecast.aiId].position;
        const direction = {UP:'LONG', DOWN:'SHORT'}[forecastDirection(forecast)];
        if (!position || !direction || position.direction !== direction ||
            position.openedAt !== opened.observedAt || position.entryPrice !== opened.price ||
            position.symbol !== symbol ||
            ledger.journal.slice(index + 1).some(event => event.aiId === forecast.aiId && event.kind !== 'CANCELLED')) {
          fail('P9b requires the original unsettled P4 position');
        }
        const {margin, units, entryPrice} = position;
        const boundAt = beforeTarget(new Date(Math.max(utcTime(opened.observedAt),
          utcTime(roundProof.confirmedAt), utcTime(ledger.lastBatchAt))).toISOString());
        await store.append('reservation', id, {...binding, commitment:roundProof.commitment,
          boundAt, position:{margin, direction, units, entryPrice}});
      }
      const record = await readDraft();
      const {confirmedAt} = await confirm('reservation', id, record);
      return {forecastId, roundId, reservedMargin:record.position.margin, confirmedAt};
    },

    async settle(forecastId, ...extra) {
      if (extra.length) fail('P9b settlement uses only verified P4 results');
      const roundProof = await requireRound();
      const {ledger, outcome, opened, index, binding} = await load(forecastId);
      const id = sha256([wallet, forecastId]);
      const {record:reservation, proof} = await readAttestation('reservation', id,
        () => readReservation(id, binding, roundProof));
      if (!proof) {
        fail('P9b requires a margin reservation confirmed before cutoff');
      }

      const closed = ledger.journal.slice(index + 1).find(event =>
        event.aiId === binding.aiId && event.kind !== 'CANCELLED');
      if (outcome?.status !== 'SCORED_MOCK_NONLIVE' || outcome.sourceMode !== MOCK_MARKET_SOURCE ||
          !closed || closed.orderId !== mockForecastOrderId(forecastId, 'close') || closed.kind !== 'CLOSED' ||
          outcome.observation.evidence !== 'MOCK_NONLIVE:sha256:' + sha256([opened, closed]) ||
          utcTime(adapter.stamp()) < utcTime(outcome.scoredAt)) {
        fail('P9b requires a verified P4 settlement and score');
      }
      const {realizedPnl:rawPnl} = closed;
      const {position} = reservation;
      if (rawPnl !== positionPnl(position, closed.price)) fail('P9b raw PnL differs from the reserved position');
      const {basisPoints, nonce, commitment} = roundProof;
      const reservedMargin = position.margin;
      const rounded = Math.sign(rawPnl) * Math.round(Math.abs(rawPnl) * (basisPoints / 10_000));
      const gamePnl = Math.max(-reservedMargin, rounded || 0);
      return store.appendExact('settlement', id, {
        ...binding, sourceMode:MOCK_MARKET_SOURCE, basisPoints, nonce, commitment,
        reservedMargin, rawPnl, gamePnl, virtualProceeds:reservedMargin + gamePnl,
        reservationSha256:sha256(reservation), outcomeSha256:sha256(outcome),
      });
    },
  });
}
