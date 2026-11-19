import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, open, readdir, realpath, unlink} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const MAX_RECORD_BYTES = 8192;
const HASH = /^[a-f0-9]{64}$/;
const RECORD = /^(wallet-owner|forecast-owner|round|round-confirmed|reservation|reservation-confirmed|settlement)-([a-f0-9]{64})$/;
const MANIFEST_ID = '0'.repeat(64);
const json = JSON.stringify;
export const fxHash = value => createHash('sha256').update(json(value)).digest('hex');
export const fxMac = key => {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new RangeError('An explicit 32-byte FX key is required');
  const copy = Buffer.from(key);
  return value => createHmac('sha256', copy).update(json(['P9b/v1', value])).digest('hex');
};
const fail = message => { throw new RangeError(message); };
const auditError = message => Object.assign(new Error(message), {code:'FORWARD_FX_AUDIT_MISMATCH'});

export async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function fxRecordStore(directory, mac, prefix = 'p9b') {
  const pathFor = (kind, id) => join(directory, `${prefix}-${kind}-${id}.json`);
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

  async function publish(kind, id, payload) {
    let published = false;
    let saved = await read(kind, id);
    if (saved === null) {
      const path = join(directory, '.' + prefix + '-' + randomUUID() + '.tmp');
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
        try {
          await link(path, pathFor(kind, id));
          published = true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      } finally {
        await unlink(path);
      }
      saved = await read(kind, id);
    }
    // Also make a competing publisher's link durable before acknowledging it.
    await syncDirectory(directory);
    if (saved === null) fail('P9b journal record disappeared');
    return {saved, published};
  }

  const append = async (kind, id, payload) => (await publish(kind, id, payload)).saved;

  async function appendExact(kind, id, payload) {
    const saved = await append(kind, id, payload);
    if (json(saved) !== json(payload)) fail('Conflicting P9b journal record');
    return saved;
  }

  return {read, append, appendExact, publish};
}

async function verifyDirectories(primary, anchor) {
  const [left, right] = await Promise.all([primary, anchor].map(async directory => {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || await realpath(directory) !== directory || (stat.mode & 0o022) ||
        (process.geteuid && stat.uid !== process.geteuid())) {
      throw auditError('FX audit paths must be real server-owned local directories');
    }
    return stat;
  }));
  if (left.dev === right.dev && left.ino === right.ino) {
    throw auditError('FX journal and audit anchor cannot share a directory inode');
  }
}

export function containsFxPath(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

function auditConfig({journalDirectory, auditAnchorDirectory, signingKey}) {
  if ([journalDirectory, auditAnchorDirectory].some(path => typeof path !== 'string' || !path.trim())) {
    throw auditError('An explicit journal and independent FX audit anchor directory are required');
  }
  const primary = resolve(journalDirectory);
  const anchor = resolve(auditAnchorDirectory);
  if (containsFxPath(primary, anchor) || containsFxPath(anchor, primary)) {
    throw auditError('FX journal and audit anchor must occupy independent directories');
  }
  const mac = fxMac(signingKey);
  const primaryManifest = fxRecordStore(primary, value => mac(['P9c manifest', 'journal', value]), 'p9c');
  const anchorManifest = fxRecordStore(anchor, value => mac(['P9c manifest', 'anchor', value]), 'p9c');
  return {primary, anchor, mac, primaryManifest, anchorManifest};
}

/** Explicit one-time provisioning for two dedicated, empty server directories. */
export async function provisionFxAudit(config) {
  const {primary, anchor, primaryManifest, anchorManifest} = auditConfig(config);
  await verifyDirectories(primary, anchor);
  const [primaryNames, anchorNames] = await Promise.all([readdir(primary), readdir(anchor)]);
  if (primaryNames.length || anchorNames.length) {
    throw auditError('FX audit provisioning requires two empty directories');
  }
  const manifest = {instance:randomUUID(), journal:fxHash(primary), anchor:fxHash(anchor)};
  // Exactly one provisioner may establish this pair. A partial bootstrap
  // stays closed. Runtime code never creates or replaces these witnesses.
  const {published} = await primaryManifest.publish('manifest', MANIFEST_ID, manifest);
  if (!published) throw auditError('FX audit journal is already provisioned');
  await anchorManifest.appendExact('manifest', MANIFEST_ID, manifest);
}

export async function requireLegacyFxDirectory(directory) {
  if ((await readdir(directory)).some(name => name.startsWith('p9c-'))) {
    throw auditError('This FX journal requires its configured P9c audit anchor');
  }
}

async function listRecords(directory, prefix) {
  const entries = new Set();
  for (const name of await readdir(directory)) {
    if (prefix === 'p9c-journal' && name.startsWith('p9b-')) {
      throw auditError('P9b records cannot be imported into a P9c journal');
    }
    if (!name.startsWith(prefix + '-')) continue;
    const record = name.endsWith('.json') && name.slice(prefix.length + 1, -5);
    if (!RECORD.test(record)) throw auditError('Invalid FX audit record name');
    entries.add(record);
  }
  return entries;
}

// Anchor first. Only the process that publishes the anchor may publish the
// matching record. Readers can wait briefly for an in-flight writer, but a
// restart never repairs a one-sided pair, even when the candidate is known.
async function requirePair(read, description) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const result = await read();
    if (result !== undefined) return result;
    if (attempt < 24) await delay(10);
  }
  throw auditError('Missing FX journal record or audit anchor for ' + description);
}

export async function openFxAudit(config) {
  const {primary, anchor, mac, primaryManifest, anchorManifest} = auditConfig(config);
  let instance;
  async function verifyManifests() {
    await verifyDirectories(primary, anchor);
    const [local, external] = await Promise.all([
      primaryManifest.read('manifest', MANIFEST_ID), anchorManifest.read('manifest', MANIFEST_ID),
    ]);
    if (!local || json(local) !== json(external) || local.journal !== fxHash(primary) ||
        local.anchor !== fxHash(anchor) || typeof local.instance !== 'string' ||
        (instance !== undefined && local.instance !== instance)) {
      throw auditError('Missing or mismatched FX audit manifests');
    }
    return local.instance;
  }
  instance = await verifyManifests();
  // Keep the legacy format, but mark the filenames so a lost manifest cannot
  // make an otherwise intact P9c journal look like a usable P9b journal.
  const store = fxRecordStore(primary, mac, 'p9c-journal');
  const witness = fxRecordStore(anchor, value => mac(['P9c record', instance, value]), 'p9c-anchor');

  async function pair(kind, id) {
    // A successful writer publishes the anchor before the journal. Reading
    // in the same order may briefly see one side; that state is never usable.
    const commitment = await witness.read(kind, id);
    const record = await store.read(kind, id);
    if (!commitment && !record) return null;
    if (!commitment || !record) return undefined;
    if (!HASH.test(commitment.sha256) || commitment.sha256 !== fxHash(record)) {
      throw auditError('FX journal record does not match its independent audit commitment');
    }
    return record;
  }

  async function verify() {
    await verifyManifests();
    const [committed, local] = await Promise.all([
      listRecords(anchor, 'p9c-anchor'), listRecords(primary, 'p9c-journal'),
    ]);
    for (const name of new Set([...committed, ...local])) {
      const [, kind, id] = RECORD.exec(name);
      const record = await requirePair(() => pair(kind, id), kind);
      if (!record) throw auditError('FX audit record disappeared during verification');
    }
  }

  async function read(kind, id) {
    return requirePair(() => pair(kind, id), kind);
  }

  async function append(kind, id, payload) {
    let record = await read(kind, id);
    if (!record) {
      const {published} = await witness.publish(kind, id, {sha256:fxHash(payload)});
      if (published) {
        if (await store.read(kind, id)) throw auditError('FX journal record existed without its audit anchor');
        await store.appendExact(kind, id, payload);
      }
      record = await read(kind, id);
      if (!record) throw auditError('FX audit record disappeared during publication');
    }
    // A replay may observe the final link from an interrupted writer before
    // that writer synced the directory. Confirm durability before returning.
    await syncDirectory(primary);
    return record;
  }

  async function appendExact(kind, id, payload) {
    const record = await append(kind, id, payload);
    if (json(record) !== json(payload)) fail('Conflicting P9b journal record');
    return record;
  }

  await verify();
  return {verify, read, append, appendExact};
}
