/**
 * Google Apps Script backend. Deploy: Extensions > Apps Script in any Google account,
 * paste this file, set GOOGLE_CLIENT_ID below, run authorize() once (creates the Drive folder),
 * Deploy > New deployment > Web app, "Execute as: Me", "Who has access: Anyone". Copy the URL into API_URL in app.js.
 * Visitors sign in with Google (auth); every other action is tied to that signed-in account by a session id.
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
// OAuth "Web application" client ID from Google Cloud Console; must be the same value as GOOGLE_CLIENT_ID in app.js.
const GOOGLE_CLIENT_ID = '593857897186-p3hjif0elcd9ouk2u5j62kmf4rnl2m3p.apps.googleusercontent.com';
const SESSION_SECONDS = 21600; // 6 h, the script cache maximum; after that people tap "Masuk dengan Google" again

function doPost(e) {
  let out;
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.action === 'auth') out = auth(String(d.idToken || ''));
    else {
      // Every other action acts only for the Google account that signed in: the email comes from the session,
      // never from the request, so nobody can read or upload as someone else by typing their email.
      const email = sessionEmail(d.session);
      if (d.action === 'register') out = register(String(d.name || '').trim().slice(0, 60), email, d);
      else if (d.action === 'login') out = login(email);
      else if (d.action === 'startUpload') out = startUpload(email, d);
      else if (d.action === 'finishUpload') out = finishUpload(email, d);
      else if (d.action === 'preview') out = preview(email, d);
      else if (d.action === 'savePreview') out = savePreview(email, d);
      else if (d.action === 'logout') { CacheService.getScriptCache().remove('sess:' + d.session); out = {}; }
      else throw new Error('Unknown action');
    }
  } catch (err) {
    out = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// Google sign-in: the page sends the ID token Google gave it. Google's tokeninfo endpoint checks the signature and expiry;
// we check it was issued for THIS site (aud) by Google (iss) and that Google has confirmed the email address.
function auth(idToken) {
  const fail = 'Login Google gagal. Coba lagi.';
  if (!idToken) throw new Error(fail);
  const check = () => UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  // Google may push back when busy (429) or hiccup (5xx): that's not a bad token, so ask once more before giving up.
  const busy = (r) => r.getResponseCode() === 429 || r.getResponseCode() >= 500;
  let res = check();
  if (busy(res)) { Utilities.sleep(800 + Math.random() * 700); res = check(); }
  if (busy(res)) throw new Error('Google sedang sibuk. Coba lagi sebentar lagi.');
  if (res.getResponseCode() !== 200) throw new Error(fail);
  const t = JSON.parse(res.getContentText());
  if (t.aud !== GOOGLE_CLIENT_ID || !/^(https:\/\/)?accounts\.google\.com$/.test(t.iss) || String(t.email_verified) !== 'true') throw new Error(fail);
  const email = String(t.email || '').trim().toLowerCase();
  // Apostrophes are allowed (some company addresses have them, e.g. o'brien@…); userFolder() escapes them for Drive search.
  if (!/^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/.test(email)) throw new Error(fail);
  const session = Utilities.getUuid(); // random, unguessable
  CacheService.getScriptCache().put('sess:' + session, email, SESSION_SECONDS);
  // Known user: signed straight in. New user: the page asks for their name and consent, then calls register.
  return userFolder(email) ? { session, email, registered: true, ...login(email) } : { session, email, registered: false, googleName: String(t.name || '') };
}

function sessionEmail(session) {
  const cache = CacheService.getScriptCache();
  const email = /^[0-9a-f-]{36}$/.test(String(session)) && cache.get('sess:' + session);
  if (!email) throw new Error('Sesi berakhir. Silakan masuk lagi.');
  cache.put('sess:' + session, email, SESSION_SECONDS); // sliding: 6 h from the LAST action, so active people never time out mid-upload
  return email;
}

// Drive search lags a few seconds behind new folders, so a just-created folder is remembered here first.
// shortcut: the cache keeps entries up to 6 h and may drop them early; after that the Drive search (by then up to date) takes over.
function userFolder(email) {
  const cached = cachedFolder(email);
  if (cached) return cached;
  // Email comes from Google (no " or \, checked in auth); escape apostrophes so they can't end the quoted Drive search term.
  const it = root().searchFolders(`title contains '_${email.replace(/'/g, "\\'")}' and trashed = false`);
  while (it.hasNext()) { const f = it.next(); if (f.getName().endsWith('_' + email)) return rememberFolder(email, f); }
  return null;
}

function cachedFolder(email) {
  const cache = CacheService.getScriptCache();
  const id = cache.get('folder:' + email);
  if (!id) return null;
  try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* deleted: fall back to search */ }
  cache.remove('folder:' + email);
  return null;
}

function rememberFolder(email, f) { CacheService.getScriptCache().put('folder:' + email, f.getId(), 21600); return f; }

function songFolderName(i) { return String(i + 1).padStart(2, '0') + ' - ' + SONGS[i]; }

function register(name, email, d) {
  if (!name) throw new Error('Nama wajib diisi.');
  if (d.agreed !== true) throw new Error('Persetujuan wajib dicentang.');
  // The page shows its own copy of the statement; refuse if it isn't the version saved below.
  if (d.consentVersion !== CONSENT_VERSION) throw new Error('Halaman sudah diperbarui. Muat ulang halaman, lalu coba lagi.');
  let existing = userFolder(email), f = existing;
  if (!f) {
    // No site-wide lock: in a 100-user test it let only ~1 new user per second through. Instead a per-email note says
    // "being created"; a second request for the same email waits for that folder rather than making its own.
    // shortcut: the note isn't atomic, so two requests for one email within the same few ms can still make two folders
    // (only possible from two devices at once); switch to a real per-email lock if that ever shows up in Drive.
    const cache = CacheService.getScriptCache(), key = 'creating:' + email;
    for (let t = 0; t < 10 && cache.get(key) && !(f = cachedFolder(email)); t++) Utilities.sleep(500);
    existing = f;
    if (!f) {
      cache.put(key, '1', 30);
      f = rememberFolder(email, root().createFolder(name.replace(/[\/\\]/g, '') + '_' + email));
    }
  }
  saveConsent(f, name, email);
  if (existing) return login(email);
  const fresh = { name, subs: {} };
  CacheService.getScriptCache().put('subs:' + email, JSON.stringify(fresh), 21600); // new user: nothing in Drive to read yet
  return fresh;
}

// One record per time the user agrees; timestamp comes from Google's server, not the user's device.
// The statement is the server's own copy, so editing the page can't change what gets recorded.
function saveConsent(folder, name, email) {
  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', "yyyy-MM-dd HH:mm:ss 'WIB'");
  const statement = CONSENT_TEXT.replace('{NAMA}', name).replace('{EMAIL}', email);
  folder.createFile('PERSETUJUAN ' + now.replace(/:/g, '.') + '.txt',
    'Disetujui secara elektronik pada: ' + now + '\nNama Lengkap: ' + name + '\nAlamat Surel: ' + email +
    '\nVersi pernyataan: ' + CONSENT_VERSION +
    '\n\n----- Teks yang ditampilkan dan disetujui -----\n\n' + statement, MimeType.PLAIN_TEXT);
}

// Change CONSENT_VERSION here AND data-version on #consentText in index.html whenever the wording changes.
const CONSENT_VERSION = '2026-11-25';
const CONSENT_TEXT = `SURAT PERNYATAAN DAN PERSETUJUAN PENGGUNAAN MATERI VIDEO
(USER-GENERATED CONTENT CONSENT & RELEASE FORM)

Surat Pernyataan dan Persetujuan Penggunaan Materi Video (“Pernyataan”) ini dibuat dan disetujui secara elektronik melalui situs web resmi oleh pihak yang mengisi data di bawah ini:

Nama Lengkap : {NAMA}
Alamat Surel : {EMAIL}
Untuk selanjutnya disebut sebagai “Kontributor”.

Dengan ini Kontributor menyatakan secara sadar, tanpa paksaan dari pihak mana pun, serta mengikatkan diri pada ketentuan-ketentuan sebagai berikut:

1. PENYERAHAN MATERI VIDEO DAN PENGGUNAANNYA

a. Kontributor secara sukarela menyerahkan rekaman audio-visual (“Materi Video”) untuk proyek perayaan 7 (tujuh) tahun album “Menari Dengan Bayangan” milik musisi “Hindia” yang dikelola oleh PT Sepuluh Dua Empat beserta mitra produksinya (“Penyelenggara”), serta memberikan izin penuh, non-eksklusif, dapat dialihkan, dan tidak dapat ditarik kembali kepada Penyelenggara untuk menyunting, memotong, mengubah format, dan menayangkan Materi Video tersebut baik sebagian maupun seluruhnya pada video musik utama di YouTube, seluruh karya turunan media sosial (termasuk namun tidak terbatas pada Instagram Reels, TikTok, Threads, YouTube Shorts, dan materi promosi berbayar), maupun pertunjukan langsung di seluruh dunia tanpa batasan waktu.

b. Kontributor menjamin bahwa Materi Video adalah karya asli milik sendiri yang bebas dari pelanggaran hak cipta pihak lain, maupun muatan melanggar hukum, serta menyetujui bahwa seluruh hak cipta atas hasil akhir video musik dan karya turunannya sepenuhnya menjadi hak milik tunggal Penyelenggara dan/atau musisi Hindia sesuai Undang-Undang Nomor 28 Tahun 2014 tentang Hak Cipta (“UU 28/2014”).

c. Kontributor memberikan persetujuan tertulis atas penggunaan wajah, suara, nama, dan penampilannya untuk kepentingan komersial maupun non-komersial, serta menjamin telah memperoleh izin penuh dari setiap individu lain yang wajah maupun suaranya ikut terekam di dalam Materi Video.

d. Kontributor memahami bahwa partisipasi ini bersifat sukarela tanpa kewajiban Penyelenggara untuk menayangkan setiap kiriman video, dan penggunaan Materi Video pada video musik maupun karya turunan media sosial tidak menimbulkan hak atas royalti, honorarium, bagi hasil monetisasi, atau kompensasi finansial apa pun bagi Kontributor maupun pihak ketiga di dalamnya pada saat ini maupun di masa mendatang.

e. Kontributor memberikan persetujuan eksplisit kepada Penyelenggara untuk mengumpulkan, menyimpan, dan memproses data pribadi Kontributor (termasuk identitas diri dan data biometrik) guna keperluan verifikasi hak dan publikasi karya sesuai dengan Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi.

f. Kontributor melepaskan PT Sepuluh Dua Empat, musisi Hindia, dan seluruh mitra produksi dari segala tuntutan hukum di kemudian hari, serta bersedia bertanggung jawab penuh dan mengganti kerugian Penyelenggara atas segala klaim pihak ketiga atau biaya hukum yang timbul akibat pelanggaran jaminan orisinalitas, hak cipta, hak potret pihak ketiga, maupun ketidakbenaran pernyataan ini.

g. Kontributor menjamin kebenaran seluruh data yang diisi dan menyatakan telah berusia minimal 18 (delapan belas) tahun atau cakap secara hukum.

[X] Saya telah membaca, memahami dan menyetujui seluruh syarat dan ketentuan di atas secara sadar dan tanpa paksaan dari pihak manapun untuk dapat dipergunakan sebagaimana mestinya`;

// Each user's upload list is kept in the script cache, so a returning user skips Drive entirely.
// shortcut: files changed by hand in Drive show up only when the entry expires (max 6 h); uploads made through the site clear it at once (forgetSubs).
function login(email) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('subs:' + email);
  if (hit) return JSON.parse(hit);
  const r = readSubsFromDrive(email);
  cache.put('subs:' + email, JSON.stringify(r), 21600);
  return r;
}

function readSubsFromDrive(email) {
  const f = userFolder(email);
  if (!f) throw new Error('Email belum terdaftar.');
  // Two Drive API calls (song folders, then all their files) instead of ~24 DriveApp calls, one pair per song.
  const songOf = {}; // song folder id -> song index
  driveList(`'${f.getId()}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, 'files(id,name)')
    .forEach((x) => { const i = SONGS.findIndex((_, k) => songFolderName(k) === x.name); if (i >= 0) songOf[x.id] = i; });
  const subs = {}, newest = {};
  const ids = Object.keys(songOf);
  if (ids.length) {
    driveList(`(${ids.map((id) => `'${id}' in parents`).join(' or ')}) and trashed = false`, 'files(name,parents,createdTime)')
      .forEach((x) => {
        const i = songOf[x.parents.find((p) => p in songOf)];
        if (newest[i] == null || x.createdTime > newest[i]) { newest[i] = x.createdTime; subs[i] = x.name; } // ISO times compare as text
      });
  }
  return { name: f.getName().slice(0, -(email.length + 1)), subs };
}

// shortcut: reads one page (up to 1000 results); a user has at most 12 song folders with ~1 file each, so it never needs more.
function driveList(q, fields) {
  const url = 'https://www.googleapis.com/drive/v3/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true' +
    '&fields=' + encodeURIComponent(fields) + '&q=' + encodeURIComponent(q);
  return JSON.parse(UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getContentText()).files || [];
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
  forgetSubs(email);
  CacheService.getScriptCache().remove('thumb:' + email + ':' + i); // the old preview image no longer matches
  // Old file is removed only in finishUpload, after the new one has fully arrived, so a failed re-upload never loses it.
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

// Called after the browser finishes uploading: keeps only the newest file in the song folder.
// Older ones go to the Drive owner's Trash (recoverable for 30 days), not deleted outright.
function finishUpload(email, d) {
  const i = Number(d.song);
  if (!(i >= 0 && i < SONGS.length)) throw new Error('Lagu tidak valid.');
  const f = userFolder(email);
  if (!f) throw new Error('Email belum terdaftar.');
  const it = f.getFoldersByName(songFolderName(i));
  if (!it.hasNext()) return {};
  const files = [];
  const all = it.next().getFiles();
  while (all.hasNext()) files.push(all.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  files.slice(1).forEach((x) => x.setTrashed(true));
  forgetSubs(email); // a login during the upload may have cached the list without this file
  return { kept: files[0] ? files[0].getName() : null };
}

// Drops the cached upload list (see login) so the next login reads Drive. Called when an upload starts AND when it
// finishes: if the finish call is lost under load, the list cleared at start still can't show the song as missing.
function forgetSubs(email) { CacheService.getScriptCache().remove('subs:' + email); }

// Thumbnails live in the person's folder (not the song folder, so finishUpload's "keep newest" never touches them),
// named after the exact uploaded file they show: a thumbnail of a replaced video can never be shown for the new one.
const posterPrefix = (i) => 'preview-' + String(i + 1).padStart(2, '0') + '-';

// The page grabs a frame from the upload and sends it here right after the upload finishes.
function savePreview(email, d) {
  const i = Number(d.song);
  if (!(i >= 0 && i < SONGS.length)) throw new Error('Lagu tidak valid.');
  const fileId = String(d.fileId || ''), image = String(d.image || '');
  if (!/^[\w-]{10,100}$/.test(fileId)) throw new Error('File tidak valid.');
  const m = image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m || image.length > 200000) throw new Error('Gambar tidak valid.'); // a 480 px JPEG is ~30-70 KB
  const f = userFolder(email);
  if (!f) throw new Error('Email belum terdaftar.');
  const old = f.searchFiles(`title contains '${posterPrefix(i)}' and trashed = false`);
  while (old.hasNext()) old.next().setTrashed(true); // only the newest upload's thumbnail is kept
  f.createFile(Utilities.newBlob(Utilities.base64Decode(m[1]), 'image/jpeg', posterPrefix(i) + fileId + '.jpg'));
  if (image.length < 95000) CacheService.getScriptCache().put('thumb:' + email + ':' + i, image, 21600);
  return {};
}

// A still image of the person's own upload for one song, for the song page on later visits, sent as a data URL:
// the file itself stays private (no public links, no Drive key in the browser). Prefers the thumbnail the page saved
// at upload time (there immediately); otherwise Drive's own thumbnail, which takes a few minutes after an upload.
function preview(email, d) {
  const i = Number(d.song);
  if (!(i >= 0 && i < SONGS.length)) throw new Error('Lagu tidak valid.');
  const cache = CacheService.getScriptCache(), key = 'thumb:' + email + ':' + i;
  const hit = cache.get(key);
  if (hit) return { image: hit };
  const f = userFolder(email);
  if (!f) throw new Error('Email belum terdaftar.');
  const it = f.getFoldersByName(songFolderName(i));
  if (!it.hasNext()) return { image: null };
  const newest = driveList(`'${it.next().getId()}' in parents and trashed = false`, 'files(id,createdTime,thumbnailLink)')
    .sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1))[0];
  if (!newest) return { image: null };
  const saved = f.getFilesByName(posterPrefix(i) + newest.id + '.jpg');
  if (saved.hasNext()) {
    const image = 'data:image/jpeg;base64,' + Utilities.base64Encode(saved.next().getBlob().getBytes());
    if (image.length < 95000) cache.put(key, image, 21600);
    return { image };
  }
  if (!newest.thumbnailLink) return { image: null };
  const res = UrlFetchApp.fetch(newest.thumbnailLink.replace(/=s\d+$/, '=s480'), // Drive's default is 220 px; 480 is sharp on phones
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { image: null };
  const blob = res.getBlob();
  const image = 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes());
  if (image.length < 95000) cache.put(key, image, 21600); // cache values are capped at 100 KB
  return { image };
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
