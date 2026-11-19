import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveForwardMarketSession, validateForwardPreFreezeObservation,
  validateForwardPreFreezeSeries,
} from '../../game_runtime/forward-market-session.mjs';

const nyse = (date, opensAt, closesAt, earlyClose = false) => ({
  market:'XNYS', date, opensAt, closesAt, earlyClose,
  status:'OPEN', timeZone:'America/New_York',
});
const known = [
  nyse('2026-03-06', '2026-03-06T14:30:00.000Z', '2026-03-06T21:00:00.000Z'),
  nyse('2026-03-09', '2026-03-09T13:30:00.000Z', '2026-03-09T20:00:00.000Z'),
  nyse('2026-11-02', '2026-11-02T14:30:00.000Z', '2026-11-02T21:00:00.000Z'),
  nyse('2026-11-27', '2026-11-27T14:30:00.000Z', '2026-11-27T18:00:00.000Z', true),
];
const session = () => resolveForwardMarketSession({
  date:'2026-03-09', market:'XNYS', sessions:known,
});
const ms = s => Date.parse(s);
const base = () => ({
  sourceMode:'MOCK_NONLIVE', market:'XNYS', providerId:'TEST-MOCK',
  venue:'IEX', symbol:'AAPL', valueKind:'TRADE', price:250.25, volume:100,
  tradeAt:'2026-03-09T13:35:00.000Z',
  publishedAt:'2026-03-09T13:35:05.000Z',
  receivedAt:'2026-03-09T13:35:10.000Z',
  raw:'fixture-source-text', proof:'signed-fixture-proof',
});
const verifyEvidence = evidence => evidence.proof === 'signed-fixture-proof' &&
  evidence.raw === 'fixture-source-text' && evidence.symbol === 'AAPL';
const input = (observation = base(), overrides = {}) => ({
  observation, session:session(), verifyEvidence,
  now:ms('2026-03-09T13:35:30.000Z'),
  cutoff:ms('2026-03-09T13:35:20.000Z'),
  maxAgeMs:60_000, ...overrides,
});

test('P9a accepts an explicitly known ordinary market session', () => {
  const s = session();
  assert.equal(s.timeZone, 'America/New_York');
  assert.equal(s.startMs, ms('2026-03-09T13:30:00.000Z'));
  assert.equal(Object.isFrozen(s), true);
});

test('P9a rejects unknown holidays, weekends and unsupported exchanges', () => {
  for (const date of ['2026-11-26', '2026-03-07', '2026-12-25']) {
    assert.throws(() => resolveForwardMarketSession({market:'XNYS', date, sessions:known}));
  }
  assert.throws(() => resolveForwardMarketSession({market:'XTKS', date:'2026-03-09', sessions:known}));
});

test('P9a correctly accepts both US DST transitions without fixed UTC offset', () => {
  const before = resolveForwardMarketSession({date:'2026-03-06', sessions:known});
  const after = session();
  const winter = resolveForwardMarketSession({date:'2026-11-02', sessions:known});
  assert.equal(new Date(before.startMs).getUTCHours(), 14);
  assert.equal(new Date(after.startMs).getUTCHours(), 13);
  assert.equal(new Date(winter.startMs).getUTCHours(), 14);
});

test('P9a rejects a wrong spring UTC offset or untrusted calendar timezone', () => {
  const wrong = [nyse('2026-03-09',
    '2026-03-09T14:30:00.000Z', '2026-03-09T21:00:00.000Z')];
  assert.throws(() => resolveForwardMarketSession({date:'2026-03-09', sessions:wrong}), /DST mismatch/);
  assert.throws(() => resolveForwardMarketSession({date:'2026-03-09', sessions:[
    {...known[1], timeZone:'UTC'},
  ]}));
});

test('P9a requires a declared early close and rejects ordinary hours on that date', () => {
  const half = resolveForwardMarketSession({date:'2026-11-27', sessions:known});
  assert.equal(half.earlyClose, true);
  assert.equal(half.endMs, ms('2026-11-27T18:00:00.000Z'));
  assert.throws(() => resolveForwardMarketSession({date:'2026-11-27', sessions:[
    {...known[3], earlyClose:false},
  ]}));
});

test('P9a rejects missing, duplicated or unauthenticated session objects', () => {
  assert.throws(() => resolveForwardMarketSession({date:'2026-03-09', sessions:[]}));
  assert.throws(() => resolveForwardMarketSession({date:'2026-03-09', sessions:[
    known[1], known[1],
  ]}));
  assert.throws(() => validateForwardPreFreezeObservation(input(base(), {
    session:{...session()},
  })));
});

test('P9a accepts a signed fixture known before the prediction freeze', () => {
  const value = validateForwardPreFreezeObservation(input());
  assert.equal(value.price, 250.25);
  assert.equal(value.sourceMode, 'MOCK_NONLIVE');
  assert.equal(Object.isFrozen(value), true);
  assert.equal('raw' in value, false);
});

test('P9a refuses premarket, after-hours and the exact session close', () => {
  for (const tradeAt of [
    '2026-03-09T13:29:59.999Z',
    '2026-03-09T20:00:00.000Z',
    '2026-03-09T20:01:00.000Z',
  ]) {
    const observed = base();
    observed.tradeAt = tradeAt;
    assert.throws(() => validateForwardPreFreezeObservation(input(observed)));
  }
});

test('P9a refuses information first published or received after cutoff', () => {
  assert.throws(() => validateForwardPreFreezeObservation(input({
    ...base(), publishedAt:'2026-03-09T13:35:22.000Z',
    receivedAt:'2026-03-09T13:35:24.000Z',
  })));
  assert.throws(() => validateForwardPreFreezeObservation(input({
    ...base(), receivedAt:'2026-03-09T13:35:21.000Z',
  })));
  assert.throws(() => validateForwardPreFreezeObservation(input(base(), {
    cutoff:ms('2026-03-09T13:36:00.000Z'),
  })));
});

test('P9a refuses stale, future and reversed-timestamp observations', () => {
  assert.throws(() => validateForwardPreFreezeObservation(input(base(), {
    now:ms('2026-03-09T13:50:00.000Z'),
    cutoff:ms('2026-03-09T13:49:00.000Z'),
  })));
  assert.throws(() => validateForwardPreFreezeObservation(input({
    ...base(), publishedAt:'2026-03-09T13:34:59.000Z',
  })));
  assert.throws(() => validateForwardPreFreezeObservation(input({
    ...base(), receivedAt:'2026-03-09T13:35:04.000Z',
  })));
});

test('P9a blocks forged, unsigned, unverified and LIVE source data', () => {
  assert.throws(() => validateForwardPreFreezeObservation(input({...base(), proof:'forged'})));
  assert.throws(() => validateForwardPreFreezeObservation(input(base(), {
    verifyEvidence:undefined,
  })));
  assert.throws(() => validateForwardPreFreezeObservation(input({
    ...base(), sourceMode:'LIVE',
  })));
  assert.throws(() => validateForwardPreFreezeObservation(input(base(), {
    verifyEvidence:() => Promise.resolve(true),
  })));
});

test('P9a blocks zero-volume, invalid price and malformed UTC timestamp', () => {
  for (const obs of [
    {...base(), volume:0},
    {...base(), price:Infinity},
    {...base(), price:-1},
    {...base(), tradeAt:'2026-02-30T13:35:00.000Z'},
    {...base(), tradeAt:'2026-03-09T13:35:00+00:00'},
  ]) {
    assert.throws(() => validateForwardPreFreezeObservation(input(obs)));
  }
});

test('P9a accepts sorted fixtures and rejects duplicate, reversed or mixed feed rows', () => {
  const first = {
    ...base(), tradeAt:'2026-03-09T13:34:00.000Z',
    publishedAt:'2026-03-09T13:34:05.000Z',
    receivedAt:'2026-03-09T13:34:10.000Z',
  };
  const second = base();
  const options = {
    session:session(), now:ms('2026-03-09T13:35:30.000Z'),
    cutoff:ms('2026-03-09T13:35:20.000Z'),
    verifyEvidence, maxAgeMs:300_000,
  };
  assert.equal(validateForwardPreFreezeSeries({observations:[first, second], ...options}).length, 2);
  assert.throws(() => validateForwardPreFreezeSeries({
    observations:[second, first], ...options,
  }));
  assert.throws(() => validateForwardPreFreezeSeries({
    observations:[second, second], ...options,
  }));
  assert.throws(() => validateForwardPreFreezeSeries({
    observations:[first, {...second, providerId:'OTHER-FEED'}], ...options,
  }));
});
