// Run: node Code.test.js — checks login() in Code.gs against a fake Google Drive (no Google account needed).
const fs = require('fs'), vm = require('vm'), assert = require('assert');

function load(driveFolders, driveFiles) {
  const fetched = [];
  const userFolder = { getId: () => 'U', getName: () => 'Budi Santoso_budi@x.com', isTrashed: () => false };
  const ctx = {
    CacheService: { getScriptCache: () => ({ get: () => 'U', put() {}, remove() {} }) },
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
  return { login: (e) => JSON.parse(JSON.stringify(ctx.login(e))), fetched }; // copy out of the sandbox so deepStrictEqual compares values
}

// Newest file per song wins; folders that aren't a song are ignored.
{
  const { login, fetched } = load(
    [{ id: 'F2', name: '02 - Besok Mungkin Kita Sampai' }, { id: 'F4', name: '04 - Dehidrasi' }, { id: 'FX', name: 'random folder' }],
    [
      { name: 'old.mp4', parents: ['F2'], createdTime: '2026-11-25T01:00:00.000Z' },
      { name: 'new.mp4', parents: ['F2'], createdTime: '2026-11-25T09:30:00.000Z' },
      { name: 'chat.png', parents: ['F4'], createdTime: '2026-11-25T03:00:00.000Z' },
      { name: 'stray.mp4', parents: ['FX'], createdTime: '2026-11-25T10:00:00.000Z' },
    ]);
  const r = login('budi@x.com');
  assert.deepStrictEqual(r, { name: 'Budi Santoso', subs: { 1: 'new.mp4', 3: 'chat.png' } });
  assert.strictEqual(fetched.length, 2, 'exactly two Drive calls');
  assert.ok(!fetched[1].includes("'FX'"), 'non-song folder not queried');
}

// No song folders yet: empty result, and the second call is skipped.
{
  const { login, fetched } = load([], []);
  assert.deepStrictEqual(login('budi@x.com'), { name: 'Budi Santoso', subs: {} });
  assert.strictEqual(fetched.length, 1);
}

console.log('Code.gs login(): all tests passed');
