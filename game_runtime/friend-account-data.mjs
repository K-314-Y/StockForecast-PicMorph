import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath, rename, unlink} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {DEFAULT_COMPANION, validateCompanion} from './companion.mjs';
import {DEFAULT_LOOK, validateLook} from './looks.mjs';
import {deriveForwardCompanionModel} from './forward-model.mjs';
import {getForwardMockRecordContext} from './forward-mock-lifecycle.mjs';
import {createForwardRecordReader} from './forward-records.mjs';
import {MOCK_MARKET_PAPER_MODE} from './forward-market-guard.mjs';
import {readForwardSnapshot} from './forward-store.mjs';
import {forwardWalletSummary} from './forward-wallet-view.mjs';

const serverUid = process.geteuid?.();
const decoder = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});

const profileLock = '.friend-character.lock';
const editFields = new Map([
  ['/friend/character/companion', {field:'companion', filename:'companion.json', validate:validateCompanion}],
  ['/friend/character/look', {field:'look', filename:'looks.json', validate:validateLook}],
]);

// JSON.parse validates the grammar but silently discards duplicate members.
// Scan complete string tokens, comparing decoded keys within each object.
export function parseFriendProfileJson(text) {
  const value = JSON.parse(text);
  const objects = [];
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"(\s*:)?|[{}]/g)) {
    if (match[0] === '{') objects.push(new Set());
    else if (match[0] === '}') objects.pop();
    else if (match[1]) {
      const key = JSON.parse(match[0].slice(0, -match[1].length));
      const keys = objects.at(-1);
      if (keys.has(key)) throw Error('Duplicate profile field');
      keys.add(key);
    }
  }
  return value;
}

function inside(parent, path) {
  const child = relative(parent, path);
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep);
}

function absolutePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value !== resolve(value) ||
      value.split(sep).includes('local_state')) {
    throw new RangeError('Friend wallets require explicit canonical paths outside local_state');
  }
  return value;
}

async function directoryIdentity(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== serverUid || (stat.mode & 0o7777) !== 0o700 ||
      await realpath(path) !== path) {
    throw new Error('Friend wallet directories must be real, server-owned and mode 0700');
  }
  return stat.dev + ':' + stat.ino;
}

function fileIdentity(stat) {
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== serverUid || (stat.mode & 0o7777) !== 0o600) {
    throw new Error('Invalid friend wallet file: expected a server-owned 0600 regular file with one link');
  }
  return stat.dev + ':' + stat.ino;
}

async function privateFileIdentity(path) {
  try { return fileIdentity(await lstat(path)); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readProfileFile(path, field, limit, validate, defaults) {
  const before = await privateFileIdentity(path);
  if (before === null) return {created:false, revision:0, ...defaults};
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (fileIdentity(stat) !== before || stat.size < 1 || stat.size > limit) throw Error('Invalid profile file');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== stat.size || after.size !== length || stat.ctimeMs !== after.ctimeMs ||
        fileIdentity(after) !== before || await privateFileIdentity(path) !== before) throw Error('Profile changed');
    const record = parseFriendProfileJson(decoder.decode(buffer.subarray(0, length)));
    if (record?.schema !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
        !Object.hasOwn(record, field) || Object.keys(record).length !== 3) throw Error('Invalid profile record');
    return {created:true, revision:record.revision, ...validate(record[field])};
  } finally {
    await handle.close();
  }
}

async function readCharacter(folder) {
  const [companion, looks] = await Promise.all([
    readProfileFile(join(folder, 'companion.json'), 'companion', 4096, validateCompanion, DEFAULT_COMPANION),
    readProfileFile(join(folder, 'looks.json'), 'look', 2048, validateLook, DEFAULT_LOOK),
  ]);
  return {companion, looks, model_version:companion.created ? deriveForwardCompanionModel(companion).model_version : null};
}

function validateEdit(spec, payload) {
  if (!payload || !Object.hasOwn(payload, spec.field) || !Object.hasOwn(payload, 'expected_revision') ||
      Object.keys(payload).length !== 2 || !Number.isSafeInteger(payload.expected_revision) ||
      payload.expected_revision < 0) throw Error('Invalid profile edit');
  return {expected:payload.expected_revision, value:spec.validate(payload[spec.field])};
}

const conflict = () => Object.assign(Error('Profile revision or lock conflict'), {code:'FRIEND_CONFLICT'});

async function requireIdentity(path, identity) {
  if (await privateFileIdentity(path) !== identity) throw Error('Profile file identity changed');
}

// Hold the descriptor until cleanup. Another writer's lock or temp is never
// removed following an unsuccessful exclusive open or a detected replacement.
async function withExclusiveFile(path, action) {
  const handle = await open(path, 'wx', 0o600);
  let published = false;
  try {
    const identity = fileIdentity(await handle.stat());
    try {
      return await action(handle, identity, () => { published = true; });
    } finally {
      if (!published) {
        await requireIdentity(path, identity);
        await unlink(path);
      }
    }
  } finally {
    await handle.close();
  }
}

async function saveCharacter(scope, spec, edit, verifyDirectories, authorize) {
  const directory = await open(scope.folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await directory.stat();
    if (stat.dev + ':' + stat.ino !== scope.folderIdentity || stat.uid !== serverUid ||
        (stat.mode & 0o7777) !== 0o700) throw Error('Friend wallet scope changed');
    // Node has no renameat/unlinkat. Anchor every mutation and cleanup to this
    // open directory on Linux, even if its configured pathname moves.
    const folder = '/proc/self/fd/' + directory.fd;
    const lock = join(folder, profileLock);
    const target = join(folder, spec.filename);
    await verifyDirectories();
    authorize();
    const result = await withExclusiveFile(lock, async (_lockHandle, lockIdentity) => {
      const original = await privateFileIdentity(target);
      const character = await readCharacter(folder);
      const current = spec.field === 'companion' ? character.companion : character.looks;
      if (current.revision !== edit.expected || current.revision === Number.MAX_SAFE_INTEGER) throw conflict();
      const revision = current.revision + 1;
      const record = {schema:1, revision, [spec.field]:edit.value};
      const temp = join(folder, '.friend-character-' + randomUUID() + '.tmp');
      await withExclusiveFile(temp, async (handle, identity, published) => {
        await handle.writeFile(JSON.stringify(record) + '\n');
        await handle.sync();
        await verifyDirectories();
        await requireIdentity(lock, lockIdentity);
        await requireIdentity(temp, identity);
        await requireIdentity(target, original);
        authorize();
        await rename(temp, target);
        published();
        await directory.sync();
        await requireIdentity(target, identity);
      });
      return readCharacter(folder);
    }).catch(err => {
      if (err.code === 'EEXIST') throw conflict();
      throw err;
    });
    await directory.sync();
    return result;
  } finally {
    await directory.close();
  }
}

async function readSummary(file) {
  const before = await privateFileIdentity(file);
  function verifyOpened(stat) {
    if (fileIdentity(stat) !== before) throw new Error('Friend wallet file changed during read');
  }
  const snapshot = await readForwardSnapshot(file, {verifyOpened}).catch(err => {
    if (err.code !== 'FORWARD_STORE_UNINITIALIZED') throw err;
    return null;
  });
  if (await privateFileIdentity(file) !== before || (snapshot === null) !== (before === null)) {
    throw new Error('Friend wallet file changed during read');
  }
  if (snapshot === null) return {status:'uninitialized', summary:null};
  if (snapshot.ledger.mode !== MOCK_MARKET_PAPER_MODE) throw new Error('Friend summary requires MOCK_NONLIVE');
  return {status:'MOCK_NONLIVE', summary:forwardWalletSummary(snapshot)};
}

export async function configureFriendData(walletRoot, accounts, accountRecordSources = new Map()) {
  const root = absolutePath(walletRoot);
  if (dirname(root) === root) throw new RangeError('Use a dedicated friend wallet root');
  const rootIdentity = await directoryIdentity(root);
  const scopes = new Map();
  for (const [id, value] of accounts) {
    const file = absolutePath(value);
    const folder = dirname(file);
    if (['companion.json', 'looks.json', profileLock].includes(basename(file)) ||
        basename(file).startsWith('.friend-character-')) throw Error('Wallet conflicts with profile storage');
    if (!inside(root, folder)) throw new RangeError('Each friend wallet requires a separate directory under the root');
    const lineage = new Map();
    for (let path = folder; path !== root; path = dirname(path)) {
      lineage.set(path, await directoryIdentity(path));
    }
    const folderIdentity = lineage.get(folder);
    for (const other of scopes.values()) {
      if ([...lineage.values()].includes(other.folderIdentity) ||
          [...other.lineage.values()].includes(folderIdentity)) {
        throw new RangeError('Friend wallet directories cannot be shared, nested or aliased');
      }
    }
    await privateFileIdentity(file);
    scopes.set(id, {file, folder, folderIdentity, lineage, readRecords:createForwardRecordReader()});
  }

  if (!(accountRecordSources instanceof Map)) throw new TypeError('Expected an account record source map');
  const directoryIds = new Set([rootIdentity]);
  for (const scope of scopes.values()) {
    for (const identity of scope.lineage.values()) directoryIds.add(identity);
  }
  for (const [id, config] of accountRecordSources) {
    const scope = scopes.get(id);
    const {source, forecastId, fxSource} = config ?? {};
    const context = getForwardMockRecordContext(source);
    if (!scope || context?.adapter.mode !== MOCK_MARKET_PAPER_MODE || context.walletFile !== scope.file ||
        context.directory !== join(scope.folder, 'forecasts')) throw Error('Invalid account mock record source');
    context.adapter.authorize();
    const directoryId = await directoryIdentity(context.directory);
    if (directoryIds.has(directoryId)) throw Error('Friend forecast directory must be dedicated');
    directoryIds.add(directoryId);
    const reader = createForwardRecordReader({source, forecastId, fxSource});
    const paths = [scope.file, ...['forecast','receipt','confirmation','outcome'].map(kind =>
      join(context.directory, forecastId + '.' + kind + '.json'))];
    async function identities() {
      context.adapter.authorize();
      if (await directoryIdentity(context.directory) !== directoryId) throw Error('Forecast directory changed');
      return Promise.all(paths.map(privateFileIdentity));
    }
    scope.readRecords = async () => {
      const before = await identities();
      const result = await reader();
      const after = await identities();
      if (result.status !== 'MOCK_NONLIVE' || !before.every((item, i) => item === after[i])) {
        throw Error('Configured mock record unavailable or changed');
      }
      return result;
    };
  }

  return async (id, path, payload, authorize) => {
    const spec = editFields.get(path);
    let edit;
    if (spec) {
      try { edit = validateEdit(spec, payload); }
      catch { throw Object.assign(Error('Invalid profile edit'), {code:'FRIEND_INVALID_EDIT'}); }
    }
    const scope = scopes.get(id);
    async function verifyDirectories() {
      if (!scope || await directoryIdentity(root) !== rootIdentity) throw Error('Friend wallet scope changed');
      for (const [folder, identity] of scope.lineage) {
        if (await directoryIdentity(folder) !== identity) throw Error('Friend wallet scope changed');
      }
    }
    await verifyDirectories();
    let result;
    switch (path) {
      case '/friend/character/companion':
      case '/friend/character/look':
        result = await saveCharacter(scope, spec, edit, verifyDirectories, authorize);
        break;
      case '/friend/character': result = await readCharacter(scope.folder); break;
      case '/friend/forward/records': result = await scope.readRecords(); break;
      case '/friend/forward/summary': result = await readSummary(scope.file); break;
      default: throw Error('Unknown friend data route');
    }
    await verifyDirectories();
    return result;
  };
}
