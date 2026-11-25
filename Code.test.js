// Run: node Code.test.js — checks Code.gs against a fake Google Drive and cache (no Google account needed).
const fs = require('fs'), vm = require('vm'), assert = require('assert');

const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };

function folder(id, name) {
  const kids = [], files = [];
  return {
    id, name, kids, files, getId: () => id, getName: () => name, isTrashed: () => false,
    getFoldersByName: (n) => iter(kids.filter((k) => k.name === n)),
    createFolder(n) { const k = folder(id + '/' + n, n); kids.push(k); byId[k.id] = k; return k; },
    createFile(n, body) { files.push({ n, body }); },
    getFiles: () => iter([]),
  };
}
let byId;

function load(driveFolders, driveFiles, { knownUser = true } = {}) {
  const fetched = [], counts = { rootCreates: 0, locks: 0 };
  byId = {};
  const user = folder('U', 'Budi Santoso_budi@x.com'); byId.U = user;
  const root = folder('R', 'root'); byId.R = root;
  const rootCreate = root.createFolder; root.createFolder = (n) => { counts.rootCreates++; return rootCreate(n); };
  root.searchFolders = () => iter([]); // Drive search lags: new folders never show up here in time
  const cache = new Map(knownUser ? [['folder:budi@x.com', 'U']] : []);
  const ctx = {
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { counts.locks++; const h = counts.whileWaiting; counts.whileWaiting = null; if (h) h(); return true; }, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'R' }) },
    DriveApp: { getFolderById: (id) => byId[id] },
    Utilities: { formatDate: () => '2026-11-25 10:00:00 WIB' },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    ScriptApp: { getOAuthToken: () => 'token' },
    UrlFetchApp: { fetch: (url) => {
      if (url.includes('uploadType=resumable')) return { getHeaders: () => ({ Location: 'https://upload.example/session' }) };
      const q = decodeURIComponent(url.split('&q=')[1]); fetched.push(q);
      const files = q.includes('mimeType') ? driveFolders : driveFiles.filter((f) => f.parents.some((p) => q.includes(`'${p}' in parents`)));
      return { getContentText: () => JSON.stringify({ files }) };
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/Code.gs', 'utf8'), ctx);
  const out = (fn) => (...a) => JSON.parse(JSON.stringify(fn(...a))); // copy out of the sandbox so deepStrictEqual compares values
  return { ctx, login: out(ctx.login), cache, fetched, counts, root };
}

const FOLDERS = [{ id: 'F2', name: '02 - Besok Mungkin Kita Sampai' }, { id: 'F4', name: '04 - Dehidrasi' }, { id: 'FX', name: 'random folder' }];
const FILES = [
  { name: 'old.mp4', parents: ['F2'], createdTime: '2026-11-25T01:00:00.000Z' },
  { name: 'new.mp4', parents: ['F2'], createdTime: '2026-11-25T09:30:00.000Z' },
  { name: 'chat.png', parents: ['F4'], createdTime: '2026-11-25T03:00:00.000Z' },
  { name: 'stray.mp4', parents: ['FX'], createdTime: '2026-11-25T10:00:00.000Z' },
];
const SIGNUP = { agreed: true, consentVersion: '2026-11-25' };

// Drive read: newest file per song wins; folders that aren't a song are ignored.
{
  const { login, fetched } = load(FOLDERS, FILES);
  assert.deepStrictEqual(login('budi@x.com'), { name: 'Budi Santoso', subs: { 1: 'new.mp4', 3: 'chat.png' } });
  assert.strictEqual(fetched.length, 2, 'exactly two Drive calls');
  assert.ok(!fetched[1].includes("'FX'"), 'non-song folder not queried');
}

// No song folders yet: empty result, and the second call is skipped.
{
  const { login, fetched } = load([], []);
  assert.deepStrictEqual(login('budi@x.com'), { name: 'Budi Santoso', subs: {} });
  assert.strictEqual(fetched.length, 1);
}

// Cache: a second login skips Drive; starting and finishing an upload both drop the cached list.
{
  const { ctx, login, cache, fetched } = load(FOLDERS, FILES);
  login('budi@x.com'); login('budi@x.com');
  assert.strictEqual(fetched.length, 2, 'second login served from cache');
  ctx.startUpload('budi@x.com', { song: 5, mimeType: 'video/mp4', size: 10, fileName: 'a.mp4' });
  assert.ok(!cache.has('subs:budi@x.com'), 'startUpload clears the list');
  login('budi@x.com'); // e.g. a page reload while the video is still uploading
  ctx.finishUpload('budi@x.com', { song: 5 });
  assert.ok(!cache.has('subs:budi@x.com'), 'finishUpload clears the list cached mid-upload');
}

// Sign-up of a new email, twice (double tap / retry) while Drive search still lags: one folder, lock taken once.
{
  const { ctx, root, counts, cache } = load([], [], { knownUser: false });
  const a = JSON.parse(JSON.stringify(ctx.register('Sari', 'sari@x.com', SIGNUP)));
  const b = JSON.parse(JSON.stringify(ctx.register('Sari', 'sari@x.com', SIGNUP)));
  assert.strictEqual(counts.rootCreates, 1, 'only one user folder created');
  assert.strictEqual(counts.locks, 1, 'second sign-up found the folder without the lock');
  assert.strictEqual(a.name, 'Sari'); assert.strictEqual(b.name, 'Sari');
  assert.strictEqual(root.kids[0].files.length, 2, 'a consent record per sign-up');
  assert.ok(cache.has('folder:sari@x.com'));
}

// Two sign-ups for one new email at the same moment: the second finishes while the first waits for the lock.
{
  const { ctx, counts } = load([], [], { knownUser: false });
  counts.whileWaiting = () => ctx.register('Sari', 'sari@x.com', SIGNUP);
  ctx.register('Sari', 'sari@x.com', SIGNUP);
  assert.strictEqual(counts.rootCreates, 1, 'the waiting request reuses the folder the other one created');
}

// Sign-up of an already-known email never takes the lock.
{
  const { ctx, counts } = load([], []);
  ctx.register('Budi Santoso', 'budi@x.com', SIGNUP);
  assert.strictEqual(counts.locks, 0);
  assert.strictEqual(counts.rootCreates, 0);
}

console.log('Code.gs: all tests passed');
