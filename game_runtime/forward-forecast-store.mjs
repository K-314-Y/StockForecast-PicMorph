import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, mkdir, open, realpath, rmdir, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {identifyForwardAppearanceModel} from './appearance-model.mjs';
import {MARKET_SYMBOL, MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE, utcTime} from './forward-market-guard.mjs';
import {FORWARD_AI_ID} from './forward-paper.mjs';
import {forecastDirection, hasFields, scoreMockForecast} from './forward-score.mjs';
import {readForwardSnapshot} from './forward-store.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MODES = ['TEST_ONLY', 'MARKET_UNCONNECTED'];
const MAX_RECORD_BYTES = 32 * 1024;
const INPUT_FIELDS = ['aiId', 'modelHash', 'model_version', 'symbol', 'targetAt', 'sourceMode', 'probabilities'];
const OPTIONAL_FIELDS = ['direction', 'predictedChangePct'];
const decoder = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && HASH.test(value);
const storeError = (code, message, cause) => Object.assign(new Error(message, {cause}), {code});
const corrupt = cause => storeError('FORWARD_FORECAST_CORRUPT', 'Saved forecast records failed verification', cause);

function normalizeInput(input) {
  if (!hasFields(input, INPUT_FIELDS, OPTIONAL_FIELDS) ||
      typeof input.aiId !== 'string' || !FORWARD_AI_ID.test(input.aiId) ||
      !isHash(input.modelHash) || typeof input.model_version !== 'string' ||
      typeof input.symbol !== 'string' || !MARKET_SYMBOL.test(input.symbol) ||
      !MODES.includes(input.sourceMode) || !Number.isFinite(utcTime(input.targetAt)) ||
      OPTIONAL_FIELDS.some(key => Object.hasOwn(input, key) && input[key] === undefined)) {
    throw new RangeError('Invalid forecast input; issuedAt and provenance are server-owned');
  }
  forecastDirection(input);
  return {...input, targetAt:new Date(utcTime(input.targetAt)).toISOString(),
    probabilities:{...input.probabilities}};
}

function idFor({aiId, symbol, targetAt, sourceMode}) {
  return hash(canonical({aiId, symbol, targetAt, sourceMode}));
}

function requireOpenWindow(issuedAt, checkedAt, targetAt) {
  if (!(issuedAt <= checkedAt && checkedAt < targetAt)) {
    throw storeError('FORWARD_FORECAST_CUTOFF', 'Forecast must be durably saved before its target');
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

function encode(kind, payload) {
  const checksum = hash(canonical({version:1, kind, payload}));
  return {checksum, bytes:Buffer.from(canonical({version:1, kind, payload, checksum}), 'utf8')};
}

async function readRecord(path, kind) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw corrupt(error);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_RECORD_BYTES) {
      throw corrupt();
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const envelope = JSON.parse(decoder.decode(bytes));
    if (length !== stat.size || !bytes.equals(encode(kind, envelope.payload).bytes)) throw corrupt();
    return envelope;
  } catch (error) {
    if (error.code === 'FORWARD_FORECAST_CORRUPT') throw error;
    throw corrupt(error);
  } finally {
    await handle.close();
  }
}

async function publish(directory, path, kind, payload) {
  const {bytes, checksum} = encode(kind, payload);
  if (bytes.length > MAX_RECORD_BYTES) throw new RangeError('Forecast record too large');
  const temporary = join(directory, '.forecast-' + randomUUID() + '.tmp');
  const handle = await open(temporary, 'wx', 0o600);
  let linked = false;
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path); // Atomic publication with no replacement, including across processes.
    linked = true;
    await unlink(temporary);
    await syncDirectory(directory);
    if ((await readRecord(path, kind))?.checksum !== checksum) throw corrupt();
    return checksum;
  } catch (error) {
    if (linked) {
      throw storeError('FORWARD_FORECAST_COMMIT_UNCERTAIN', 'Publication could not be verified; inspect before retrying', error);
    }
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function receiptFor(forecastId, forecastSha256) {
  return {forecastId, forecastSha256};
}

function outcomeFor(forecast, receipt, observation, scoredAt) {
  return {
    status:'SCORED_MOCK_NONLIVE', sourceMode:MOCK_MARKET_SOURCE,
    forecastId:forecast.forecastId, forecastSha256:receipt.forecastSha256, scoredAt, observation,
    score:scoreMockForecast(forecast, observation, scoredAt),
  };
}

/**
 * Internal API. Supply an existing dedicated local directory and an explicit
 * walletFile. The optional clock and readMockOutcome are server configuration.
 * readMockOutcome is a server-owned synthetic fixture reader, called only after
 * the target of a TEST_ONLY forecast. It may return null while data is pending.
 * readMockEvidence instead supplies a ledger-bound observation and fill time.
 * The ledger-bound path also verifies previously saved outcomes before use.
 * After an abnormal exit, inspect any remaining lock and temporary file with all
 * writers stopped before removing them. A forecast without a receipt and its
 * cutoff confirmation stays closed.
 */
export async function openForwardForecastStore({directory, walletFile, clock = Date.now, readMockOutcome,
  readMockEvidence}) {
  if (typeof walletFile !== 'string' || !walletFile.trim()) {
    throw new RangeError('An explicit walletFile is required');
  }
  directory = resolve(directory);
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) {
    throw new RangeError('Forecast directory must be a real local directory');
  }
  walletFile = resolve(walletFile);
  if (typeof clock !== 'function' || (readMockOutcome !== undefined && typeof readMockOutcome !== 'function') ||
      (readMockEvidence !== undefined && (typeof readMockEvidence !== 'function' || readMockOutcome !== undefined))) {
    throw new RangeError('Invalid server clock or mock source');
  }

  function now() {
    const time = clock();
    if (!Number.isSafeInteger(time)) throw new RangeError('Invalid server clock');
    const at = new Date(time).toISOString();
    if (utcTime(at) !== time) throw new RangeError('Invalid server clock');
    return at;
  }

  function pathFor(id, kind) {
    return join(directory, id + '.' + kind + '.json');
  }

  function checkMockEvidence(forecast, evidence, scoredAt) {
    if (!evidence || !(utcTime(scoredAt) >= utcTime(forecast.targetAt) &&
        utcTime(scoredAt) >= utcTime(evidence.observedAt))) {
      throw new RangeError('MOCK_NONLIVE score requires verified settlement at the target');
    }
  }

  async function withLock(id, action) {
    if (!isHash(id)) throw new RangeError('Invalid forecast ID');
    const lock = join(directory, id + '.lock');
    try {
      await mkdir(lock, {mode:0o700});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw storeError('FORWARD_FORECAST_LOCKED', 'Forecast is busy or its lock remains after a stop', error);
    }
    try {
      return await action();
    } finally {
      await rmdir(lock);
    }
  }

  async function read(id) {
    const [saved, issued, confirmed, scored] = await Promise.all([
      readRecord(pathFor(id, 'forecast'), 'forecast'),
      readRecord(pathFor(id, 'receipt'), 'receipt'),
      readRecord(pathFor(id, 'confirmation'), 'confirmation'),
      readRecord(pathFor(id, 'outcome'), 'outcome'),
    ]);
    if (!saved && !issued && !confirmed && !scored) return null;
    if (saved && !confirmed && !scored) {
      throw storeError('FORWARD_FORECAST_UNCONFIRMED', 'Forecast has no cutoff confirmation');
    }
    if (!saved || !issued || !confirmed) throw corrupt();

    const forecast = saved.payload;
    const receipt = {...issued.payload, confirmedAt:confirmed.payload?.confirmedAt};
    const outcome = scored?.payload ?? null;
    try {
      const {forecastId, issuedAt, provenance, ...input} = forecast;
      const normalized = normalizeInput(input);
      const identified = identifyForwardAppearanceModel({model_version:input.model_version, model:provenance.model});
      if (forecastId !== id || idFor(normalized) !== id || normalized.targetAt !== input.targetAt ||
        canonical(provenance) !== canonical({walletRevision:provenance.walletRevision, model:identified.model}) ||
        identified.modelHash !== input.modelHash ||
        !Number.isSafeInteger(provenance.walletRevision) || provenance.walletRevision < 0 ||
        canonical(issued.payload) !== canonical(receiptFor(id, saved.checksum)) ||
        canonical(confirmed.payload) !== canonical({receiptSha256:issued.checksum, confirmedAt:receipt.confirmedAt})) {
        throw corrupt();
      }
      requireOpenWindow(utcTime(issuedAt), utcTime(receipt.confirmedAt), utcTime(input.targetAt));
      if (scored && (!outcome || canonical(outcome) !== canonical(
        outcomeFor(forecast, receipt, outcome.observation, outcome.scoredAt)))) throw corrupt();
    } catch (error) {
      throw corrupt(error);
    }
    if (outcome && readMockEvidence) {
      const evidence = await readMockEvidence(forecast, receipt);
      checkMockEvidence(forecast, evidence, outcome.scoredAt);
      if (canonical(evidence.observation) !== canonical(outcome.observation)) {
        throw storeError('FORWARD_FORECAST_EVIDENCE_MISMATCH', 'Saved mock score does not match the signed ledger fill');
      }
    }
    // A prior write might have reached link before reporting a sync failure.
    await syncDirectory(directory);
    return {forecast, receipt, outcome};
  }

  return {
    async freeze(input) {
      input = normalizeInput(input);
      const forecastId = idFor(input);
      return withLock(forecastId, async () => {
        const existing = await read(forecastId);
        if (existing) throw storeError('FORWARD_FORECAST_EXISTS', 'Forecast is already confirmed');

        const {revision, ledger} = await readForwardSnapshot(walletFile);
        const generation = ledger.appearanceGenerations?.find(item => item.aiId === input.aiId);
        if (!generation || !Object.hasOwn(ledger.wallets, input.aiId)) {
          throw new RangeError('Wallet has no saved appearance model_version');
        }
        if (input.model_version !== generation.model_version ||
            input.modelHash !== ledger.wallets[input.aiId].modelHash) {
          throw new RangeError('Forecast model does not match the saved wallet generation');
        }

        const issuedAt = now();
        const target = utcTime(input.targetAt);
        requireOpenWindow(utcTime(issuedAt), utcTime(issuedAt), target);
        const forecast = {...input, forecastId, issuedAt,
          provenance:{walletRevision:revision, model:generation.model}};
        const checksum = await publish(directory, pathFor(forecastId, 'forecast'), 'forecast', forecast);
        const beforeReceipt = utcTime(now());
        requireOpenWindow(utcTime(issuedAt), beforeReceipt, target);
        const receipt = receiptFor(forecastId, checksum);
        const receiptSha256 = await publish(directory, pathFor(forecastId, 'receipt'), 'receipt', receipt);
        const confirmedAt = now();
        requireOpenWindow(beforeReceipt, utcTime(confirmedAt), target);
        // Attest that both immutable records were already durable before the cutoff.
        await publish(directory, pathFor(forecastId, 'confirmation'), 'confirmation', {receiptSha256, confirmedAt});
        return read(forecastId);
      });
    },

    read: forecastId => withLock(forecastId, () => read(forecastId)),

    scoreMock: forecastId => withLock(forecastId, async () => {
      const saved = await read(forecastId);
      if (!saved) throw storeError('FORWARD_FORECAST_NOT_FOUND', 'No saved forecast');
      const {forecast, receipt, outcome} = saved;
      if (forecast.sourceMode !== 'TEST_ONLY') throw new RangeError('Market scoring is closed');
      if (readMockOutcome && (await readForwardSnapshot(walletFile)).ledger.mode === MOCK_MARKET_PAPER_MODE) {
        throw new RangeError('MOCK_NONLIVE paper ledgers require signed settlement evidence');
      }
      if (outcome) return outcome;
      const pending = {status:'PENDING', forecastId};
      if (utcTime(now()) < utcTime(forecast.targetAt)) return pending;
      const evidence = readMockEvidence ? await readMockEvidence(forecast, receipt) : null;
      const observation = readMockEvidence ? evidence?.observation : await readMockOutcome?.(Object.freeze({
        forecastId, symbol:forecast.symbol, targetAt:forecast.targetAt,
      }));
      if (observation == null) return pending;
      const scoredAt = now();
      if (readMockEvidence) checkMockEvidence(forecast, evidence, scoredAt);
      const result = outcomeFor(forecast, receipt, observation, scoredAt);
      await publish(directory, pathFor(forecastId, 'outcome'), 'outcome', result);
      return (await read(forecastId)).outcome;
    }),
  };
}
