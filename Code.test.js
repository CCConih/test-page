// Run: node Code.test.js — checks login() in Code.gs against a fake Google Drive and cache (no Google account needed).
const fs = require('fs'), vm = require('vm'), assert = require('assert');

function load(driveFolders, driveFiles) {
  const fetched = [];
  const cache = new Map([['folder:budi@x.com', 'U']]);
  const userFolder = { getId: () => 'U', getName: () => 'Budi Santoso_budi@x.com', isTrashed: () => false };
  const ctx = {
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    DriveApp: { getFolderById: () => userFolder },
    ScriptApp: { getOAuthToken: () => 'token' },
    UrlFetchApp: { fetch: (url) => {
      const q = decodeURIComponent(url.split('&q=')[1]); fetched.push(q);
      const files = q.includes('mimeType') ? driveFolders : driveFiles.filter((f) => f.parents.some((p) => q.includes(`'${p}' in parents`)));
      return { getContentText: () => JSON.stringify({ files }) };
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/Code.gs', 'utf8'), ctx);
  // copy results out of the sandbox so deepStrictEqual compares values
  return { login: (e) => JSON.parse(JSON.stringify(ctx.login(e))), update: ctx.updateCachedSubs, cache, fetched };
}

const FOLDERS = [{ id: 'F2', name: '02 - Besok Mungkin Kita Sampai' }, { id: 'F4', name: '04 - Dehidrasi' }, { id: 'FX', name: 'random folder' }];
const FILES = [
  { name: 'old.mp4', parents: ['F2'], createdTime: '2026-11-25T01:00:00.000Z' },
  { name: 'new.mp4', parents: ['F2'], createdTime: '2026-11-25T09:30:00.000Z' },
  { name: 'chat.png', parents: ['F4'], createdTime: '2026-11-25T03:00:00.000Z' },
  { name: 'stray.mp4', parents: ['FX'], createdTime: '2026-11-25T10:00:00.000Z' },
];

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

// Cache: a second login skips Drive; a finished upload updates the cached list; a dropped entry falls back to Drive.
{
  const { login, update, cache, fetched } = load(FOLDERS, FILES);
  login('budi@x.com');
  assert.deepStrictEqual(login('budi@x.com'), { name: 'Budi Santoso', subs: { 1: 'new.mp4', 3: 'chat.png' } });
  assert.strictEqual(fetched.length, 2, 'second login served from cache');
  update('budi@x.com', 5, 'senyum.mp4');
  update('budi@x.com', 1, 'ganti.mp4');
  assert.deepStrictEqual(login('budi@x.com').subs, { 1: 'ganti.mp4', 3: 'chat.png', 5: 'senyum.mp4' });
  assert.strictEqual(fetched.length, 2, 'still no Drive calls');
  cache.delete('subs:budi@x.com');
  assert.deepStrictEqual(login('budi@x.com').subs, { 1: 'new.mp4', 3: 'chat.png' });
  assert.strictEqual(fetched.length, 4, 'expired entry reads Drive again');
}

// An upload finishing while nothing is cached must not invent a partial list.
{
  const { update, cache } = load(FOLDERS, FILES);
  update('budi@x.com', 5, 'senyum.mp4');
  assert.ok(!cache.has('subs:budi@x.com'));
}

console.log('Code.gs login(): all tests passed');
