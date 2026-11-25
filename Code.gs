/**
 * Google Apps Script backend. Deploy: Extensions > Apps Script in any Google account,
 * paste this file, run authorize() once (creates the Drive folder), Deploy > New deployment > Web app,
 * "Execute as: Me", "Who has access: Anyone". Copy the URL into API_URL in app.js.
 *
 * Drive layout:  ROOT / <Name>_<email> / <NN - Song> / <uploaded files>
 * The video goes browser -> Drive directly (resumable upload), so Apps Script's 50 MB limit doesn't apply.
 */
const ALLOWED_ORIGIN = 'https://ccconih.github.io'; // test page; change to the real domain at launch // must match the site's origin exactly, or the browser upload is blocked by CORS
// Drive folder names; keep in the same order as SONGS in app.js.
const SONGS = ['Evakuasi', 'Besok Mungkin Kita Sampai', 'Jam Makan Siang', 'Dehidrasi', 'Untuk Apa - Untuk Apa', 'Secukupnya',
  'Belum Tidur', 'Apapun yang Terjadi', 'Membasuh', 'Rumah ke Rumah', 'Mata Air', 'Evaluasi'];
const IMAGE_SONG = 3; // Dehidrasi takes a screenshot; every other song is video only
const MAX_BYTES =500 * 1024 * 1024;

function doPost(e) {
  let out;
  try {
    const d = JSON.parse(e.postData.contents);
    const email = String(d.email || '').trim().toLowerCase();
    if (!/^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email)) throw new Error('Email tidak valid.');
    if (d.action === 'register') out = register(String(d.name || '').trim().slice(0, 60), email);
    else if (d.action === 'login') out = login(email);
    else if (d.action === 'startUpload') out = startUpload(email, d);
    else throw new Error('Unknown action');
  } catch (err) {
    out = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function userFolder(email) {
  // Email is validated above (no quotes), so it's safe inside the query string.
  const it = root().searchFolders(`title contains '_${email}' and trashed = false`);
  while (it.hasNext()) { const f = it.next(); if (f.getName().endsWith('_' + email)) return f; }
  return null;
}

function songFolderName(i) { return String(i + 1).padStart(2, '0') + ' - ' + SONGS[i]; }

function register(name, email) {
  if (!name) throw new Error('Nama wajib diisi.');
  const lock = LockService.getScriptLock(); lock.waitLock(10000); // avoid duplicate folders on double-submit
  try {
    const f = userFolder(email);
    if (f) return login(email);
    root().createFolder(name.replace(/[\/\\]/g, '') + '_' + email);
    return { name, subs: {} };
  } finally { lock.releaseLock(); }
}

function login(email) {
  const f = userFolder(email);
  if (!f) throw new Error('Email belum terdaftar.');
  const subs = {};
  SONGS.forEach((_, i) => {
    const sf = f.getFoldersByName(songFolderName(i));
    if (!sf.hasNext()) return;
    let newest = null;
    const files = sf.next().getFiles();
    while (files.hasNext()) { const x = files.next(); if (!newest || x.getDateCreated() > newest.getDateCreated()) newest = x; }
    if (newest) subs[i] = newest.getName();
  });
  return { name: f.getName().slice(0, -(email.length + 1)), subs };
}

function startUpload(email, d) {
  const i = Number(d.song);
  if (!(i >= 0 && i < SONGS.length)) throw new Error('Lagu tidak valid.');
  const kind = i === IMAGE_SONG ? 'image' : 'video';
  if (!String(d.mimeType).startsWith(kind + '/')) throw new Error(kind === 'image' ? 'File harus berupa gambar.' : 'File harus berupa video.');
  if (!(d.size > 0 && d.size <= MAX_BYTES)) throw new Error('Ukuran file tidak valid.');
  const f = userFolder(email);
  if (!f) throw new Error('Email belum terdaftar.');
  const it = f.getFoldersByName(songFolderName(i));
  const sf = it.hasNext() ? it.next() : f.createFolder(songFolderName(i));
  // "Ganti video" keeps old files (newest counts) so a failed re-upload never loses the previous one.
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': d.mimeType,
      'X-Upload-Content-Length': String(d.size),
      Origin: ALLOWED_ORIGIN,
    },
    payload: JSON.stringify({ name: String(d.fileName || 'upload').slice(0, 200), parents: [sf.getId()] }),
  });
  return { uploadUrl: res.getHeaders().Location };
}

const ROOT_NAME = 'MDB 7 Tahun - UGC Submissions';

function root() {
  const id = PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID');
  if (!id) throw new Error('Server belum disiapkan.'); // run authorize() first
  return DriveApp.getFolderById(id);
}

// Run once from the editor: grants Drive access and creates the submissions folder in the deploying account's Drive.
function authorize() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ROOT_FOLDER_ID')) props.setProperty('ROOT_FOLDER_ID', DriveApp.createFolder(ROOT_NAME).getId());
  Logger.log('Submissions folder: ' + root().getUrl());
}
