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
  const fetched = [], counts = { rootCreates: 0, sleeps: 0 };
  byId = {};
  const user = folder('U', 'Budi Santoso_budi@x.com'); byId.U = user;
  const root = folder('R', 'root'); byId.R = root;
  const rootCreate = root.createFolder; root.createFolder = (n) => { counts.rootCreates++; return rootCreate(n); };
  root.searchFolders = () => iter([]); // Drive search lags: new folders never show up here in time
  const cache = new Map(knownUser ? [['folder:budi@x.com', 'U']] : []);
  const ctx = {
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'R' }) },
    DriveApp: { getFolderById: (id) => byId[id] },
    // sleep = time passing while another request works; a test can make that other request finish here
    Utilities: { formatDate: () => '2026-11-25 10:00:00 WIB', sleep: () => { counts.sleeps++; const h = counts.whileWaiting; counts.whileWaiting = null; if (h) h(); } },
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

// Sign-up of a new email, twice (double tap / retry) while Drive search still lags: one folder.
{
  const { ctx, root, counts, cache } = load([], [], { knownUser: false });
  const a = JSON.parse(JSON.stringify(ctx.register('Sari', 'sari@x.com', SIGNUP)));
  const b = JSON.parse(JSON.stringify(ctx.register('Sari', 'sari@x.com', SIGNUP)));
  assert.strictEqual(counts.rootCreates, 1, 'only one user folder created');
  assert.strictEqual(counts.sleeps, 0, 'second sign-up found the folder at once, no waiting');
  assert.strictEqual(a.name, 'Sari'); assert.strictEqual(b.name, 'Sari');
  assert.strictEqual(root.kids[0].files.length, 2, 'a consent record per sign-up');
  assert.ok(cache.has('folder:sari@x.com'));
}

// Two sign-ups for one new email at the same moment: one is mid-create (note set) when the other arrives.
{
  const { ctx, counts, cache } = load([], [], { knownUser: false });
  cache.set('creating:sari@x.com', '1'); // the other request is creating the folder right now...
  counts.whileWaiting = () => ctx.rememberFolder('sari@x.com', ctx.root().createFolder('Sari_sari@x.com')); // ...and finishes while we wait
  ctx.register('Sari', 'sari@x.com', SIGNUP);
  assert.strictEqual(counts.rootCreates, 1, 'the waiting request reuses the folder the other one created');
  assert.ok(counts.sleeps >= 1);
}

// While a new user's folder is being created, the "being created" note is visible to other requests.
{
  const { ctx, root, cache } = load([], [], { knownUser: false });
  let noteSeen = false; const create = root.createFolder;
  root.createFolder = (n) => { noteSeen = cache.has('creating:sari@x.com'); return create(n); };
  ctx.register('Sari', 'sari@x.com', SIGNUP);
  assert.ok(noteSeen, 'note set before the folder is created');
}

// Different new people never wait for each other.
{
  const { ctx, counts } = load([], [], { knownUser: false });
  ctx.register('Sari', 'sari@x.com', SIGNUP); ctx.register('Dewi', 'dewi@x.com', SIGNUP);
  assert.strictEqual(counts.rootCreates, 2); assert.strictEqual(counts.sleeps, 0);
}

// Sign-up of an already-known email never waits or creates.
{
  const { ctx, counts } = load([], []);
  ctx.register('Budi Santoso', 'budi@x.com', SIGNUP);
  assert.strictEqual(counts.sleeps, 0);
  assert.strictEqual(counts.rootCreates, 0);
}

// The consent statement exists twice: on the page (what people read) and in Code.gs (what gets saved as their record).
// They must match word for word, and carry the same version.
{
  const { ctx } = load([], []);
  const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  const words = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const box = html.split('id="consentText"')[1];
  const page = words(box.slice(box.indexOf('>') + 1, box.indexOf('</ol>')).replace(/<!--[\s\S]*?-->/g, '')) + ' ' +
    words(html.split('id="agreeLabel"')[1].split('</label>')[0].replace(/^[^>]*>/, ''));
  const server = words(vm.runInContext('CONSENT_TEXT', ctx)
    .replace('{NAMA}', '—').replace('{EMAIL}', '—') // the page shows "—" until the user types
    .replace(/^[a-g]\. /gm, '')                     // the page numbers a–g with <ol type="a">
    .replace('[X] ', ''));
  if (page !== server) {
    const at = [...page].findIndex((c, k) => c !== server[k]);
    assert.fail(`consent text differs at character ${at}:\n  page:    …${page.slice(Math.max(0, at - 40), at + 60)}…\n  Code.gs: …${server.slice(Math.max(0, at - 40), at + 60)}…`);
  }
  assert.strictEqual(html.match(/id="consentText" data-version="([^"]+)"/)[1], vm.runInContext('CONSENT_VERSION', ctx), 'consent version differs between index.html and Code.gs');
}

console.log('Code.gs: all tests passed');
