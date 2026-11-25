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
    if (d.action === 'register') out = register(String(d.name || '').trim().slice(0, 60), email, d);
    else if (d.action === 'login') out = login(email);
    else if (d.action === 'startUpload') out = startUpload(email, d);
    else if (d.action === 'finishUpload') out = finishUpload(email, d);
    else throw new Error('Unknown action');
  } catch (err) {
    out = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// Drive search lags a few seconds behind new folders, so a just-created folder is remembered here first.
// shortcut: the cache keeps entries up to 6 h and may drop them early; after that the Drive search (by then up to date) takes over.
function userFolder(email) {
  const cache = CacheService.getScriptCache();
  const id = cache.get('folder:' + email);
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* deleted: fall back to search */ }
    cache.remove('folder:' + email);
  }
  // Email is validated above (no quotes), so it's safe inside the query string.
  const it = root().searchFolders(`title contains '_${email}' and trashed = false`);
  while (it.hasNext()) { const f = it.next(); if (f.getName().endsWith('_' + email)) return rememberFolder(email, f); }
  return null;
}

function rememberFolder(email, f) { CacheService.getScriptCache().put('folder:' + email, f.getId(), 21600); return f; }

function songFolderName(i) { return String(i + 1).padStart(2, '0') + ' - ' + SONGS[i]; }

function register(name, email, d) {
  if (!name) throw new Error('Nama wajib diisi.');
  if (d.agreed !== true) throw new Error('Persetujuan wajib dicentang.');
  // The page shows its own copy of the statement; refuse if it isn't the version saved below.
  if (d.consentVersion !== CONSENT_VERSION) throw new Error('Halaman sudah diperbarui. Muat ulang halaman, lalu coba lagi.');
  // Lock only "find, else create" so two requests for one email can't both create a folder.
  // Everything slow (consent file, reading song folders) runs after release, so sign-ups don't queue behind each other.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Server sedang sibuk. Coba lagi sebentar lagi.');
  let existing, f;
  try {
    existing = userFolder(email);
    f = existing || rememberFolder(email, root().createFolder(name.replace(/[\/\\]/g, '') + '_' + email));
  } finally { lock.releaseLock(); }
  saveConsent(f, name, email);
  return existing ? login(email) : { name, subs: {} };
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
  return { kept: files[0] ? files[0].getName() : null };
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
