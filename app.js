// Paste the Apps Script Web App URL here (see Code.gs). Empty = preview mode (localStorage, no real upload).
const API_URL = 'https://script.google.com/macros/s/AKfycbyyVZvBLuOZz7qteS06Y6gLOIhEKL1D6PBXNP2fImdsNbf9QgwSQ7Pom1nEp65fT3z-Ow/exec';

const SONGS = [
  ['Evakuasi', 'Footage aktivitasmu memulai hari'],
  ['Besok Mungkin Kita Sampai', 'Footage aktivitasmu bekerja/belajar di kantor/sekolah'],
  ['Jam Makan Siang (ft. Matter Mos)', 'Footage aktivitasmu makan siang bersama teman kantor/sekolah'],
  ['Dehidrasi (ft. Petra Sihombing)', 'Screenshot chat berisi ucapan terima kasih/apresiasi dari orang terdekatmu', 'image'], // 3rd field: upload type, default 'video'
  ['Untuk Apa / Untuk Apa?', 'Footage barang kesayangan yang kamu miliki'],
  ['Secukupnya', 'Footage video selfiemu sambil tersenyum (profile shot)'],
  ['Belum Tidur (ft. Sal Priadi)', 'Pilih salah satu:\n• Footage video yang kamu ambil dari atas tempat tidurmu di malam hari\n• Footage kasur kamu dari angle atas/tengah (profile shot)'],
  ['Apapun yang Terjadi', 'Footage pas ngampus/di sekolah sama tongkrongan teman-teman'],
  ['Membasuh (ft. Rara Sekar)', 'Footage yang nggak akan dihapus dari handphonemu'],
  ['Rumah ke Rumah', 'Footage figur ibu yang ada di hidupmu'],
  ['Mata Air (ft. Natasha Udu, Kamga)', 'Footage angkat tangan dengan berbagai background'],
  ['Evaluasi', 'Footage aktivitasmu menutup hari'],
];
const MAX_MB = 500;
const MAX_SECONDS = 30;

// Reads duration from the file's metadata in the browser; images resolve 0.
function videoDuration(file) {
  if (!file.type.startsWith('video/')) return Promise.resolve(0);
  return new Promise((ok) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(v.src); ok(isFinite(v.duration) ? v.duration : 0); };
    v.onerror = () => { URL.revokeObjectURL(v.src); ok(0); }; // unreadable codec (e.g. some .mov on desktop): let it through, review manually
    v.src = URL.createObjectURL(file);
  });
}

const $ = (id) => document.getElementById(id);
let user = null;   // { name, email, subs: { [songIndex]: fileName } }
let current = 0;

// ---------- API (real = Apps Script, mock = localStorage) ----------
async function call(action, data) {
  if (!API_URL) return mockCall(action, data);
  // text/plain avoids a CORS preflight, which Apps Script can't answer.
  const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action, ...data }) });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

function mockCall(action, { name, email, song, fileName }) {
  const db = JSON.parse(localStorage.getItem('mdb_db') || '{}');
  const save = () => localStorage.setItem('mdb_db', JSON.stringify(db));
  if (action === 'register') { db[email] ??= { name, subs: {} }; save(); return { name: db[email].name, subs: db[email].subs }; }
  if (action === 'login') { if (!db[email]) throw new Error('Email belum terdaftar.'); return { name: db[email].name, subs: db[email].subs }; }
  if (action === 'startUpload') { db[email].subs[song] = fileName; save(); return { uploadUrl: null }; }
  if (action === 'finishUpload') return {};
}

function putFile(url, file, onProgress) {
  if (!url) { // mock: fake progress
    return new Promise((ok) => { let p = 0; const t = setInterval(() => { onProgress(p += 20); if (p >= 100) { clearInterval(t); ok(); } }, 150); });
  }
  return new Promise((ok, fail) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress((e.loaded / e.total) * 100);
    xhr.onload = () => (xhr.status < 300 ? ok() : fail(new Error('Upload gagal (' + xhr.status + ')')));
    xhr.onerror = () => fail(new Error('Koneksi terputus, coba lagi.'));
    xhr.send(file);
  });
}

// ---------- Views ----------
function show(view) {
  for (const v of ['home', 'grid', 'song', 'done']) $('v-' + v).hidden = v !== view;
  if (view === 'grid') renderGrid();
  if (view === 'song') renderSong();
  if (view === 'done') $('doneCount').textContent = Object.keys(user.subs).length;
  window.scrollTo(0, 0);
}

function renderGrid() {
  $('userName').textContent = user.name;
  $('count').textContent = Object.keys(user.subs).length;
  $('grid').innerHTML = '';
  SONGS.forEach(([title], i) => {
    const has = user.subs[i] != null;
    const tile = document.createElement('div');
    tile.className = 'tile' + (has ? ' has' : '');
    tile.innerHTML = `<button class="box"></button><button class="btn small ${has ? 'done' : ''}">${has ? 'Ganti video?' : 'Submit Video'}</button>`;
    tile.querySelector('.box').textContent = title;
    tile.querySelectorAll('button').forEach((b) => (b.onclick = () => { current = i; show('song'); }));
    $('grid').append(tile);
  });
}

function renderSong() {
  const [title, prompt] = SONGS[current];
  const n = String(current + 1).padStart(2, '0');
  $('songTitle').textContent = `${n}. ${title}`;
  $('songPrompt').textContent = prompt;
  $('pageNum').textContent = `${n}/12`;
  const sub = user.subs[current];
  $('songStatus').textContent = sub ? `✓ Terkirim: ${sub}` : '';
  const isImage = SONGS[current][2] === 'image';
  $('fileInput').accept = isImage ? 'image/*' : 'video/*';
  $('songHint').textContent = isImage ? 'Hanya file gambar (screenshot/foto)' : 'Hanya file video · maksimal 30 detik';
  $('uploadBtn').textContent = sub ? (isImage ? 'Ganti gambar?' : 'Ganti video?') : (isImage ? 'Upload Gambar' : 'Upload Video');
  $('prevBtn').disabled = current === 0;
  $('nextBtn').disabled = current === SONGS.length - 1;
  $('uploadErr').textContent = '';
  $('progress').hidden = true;
}

function login(data) {
  user = { name: data.name, email: data.email, subs: data.subs || {} };
  localStorage.setItem('mdb_session', JSON.stringify({ name: user.name, email: user.email }));
}

// ---------- Events ----------
$('startBtn').onclick = () => (user ? show('grid') : $('consent').showModal());
// Consent: tick box unlocks only once the statement is scrolled to the end; name/email echo into the statement.
function checkConsentRead() {
  const c = $('consentText');
  if (c.scrollTop + c.clientHeight >= c.scrollHeight - 8) { $('regForm').agree.disabled = false; $('scrollHint').hidden = true; }
}
$('consentText').onscroll = checkConsentRead;
$('consent').addEventListener('toggle', checkConsentRead); // in case it all fits without scrolling
$('regForm').name.oninput = (e) => ($('cName').textContent = e.target.value.trim() || '—');
$('regForm').email.oninput = (e) => ($('cEmail').textContent = e.target.value.trim() || '—');
$('showLogin').onclick = () => { $('loginForm').hidden = false; $('loginForm').email.focus(); };

$('regForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, name = f.name.value.trim(), email = f.email.value.trim().toLowerCase();
  try {
    const res = await call('register', { name, email });
    login({ ...res, email });
    $('consent').close(); show('grid');
  } catch (err) { $('regErr').textContent = err.message; }
};

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const email = e.target.email.value.trim().toLowerCase();
  try {
    const res = await call('login', { email });
    login({ ...res, email });
    $('consent').close(); show('grid');
  } catch (err) { $('loginErr').textContent = err.message; }
};

$('uploadBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const kind = SONGS[current][2] || 'video';
  if (!file.type.startsWith(kind + '/')) return ($('uploadErr').textContent = kind === 'image' ? 'File harus berupa gambar.' : 'File harus berupa video.');
  if (file.size > MAX_MB * 1024 * 1024) return ($('uploadErr').textContent = `Maksimal ${MAX_MB} MB.`);
  if ((await videoDuration(file)) > MAX_SECONDS + 0.5) return ($('uploadErr').textContent = `Durasi video maksimal ${MAX_SECONDS} detik. Potong dulu videomu, lalu coba lagi.`);
  const song = current;
  $('uploadBtn').disabled = true; $('uploadErr').textContent = ''; $('progress').hidden = false;
  const bar = $('progress').firstElementChild;
  try {
    const { uploadUrl } = await call('startUpload', { email: user.email, song, fileName: file.name, mimeType: file.type, size: file.size });
    await putFile(uploadUrl, file, (p) => (bar.style.width = p + '%'));
    await call('finishUpload', { email: user.email, song }).catch(() => {}); // cleanup only; the new file is already saved
    user.subs[song] = file.name;
    if (current === song) renderSong();
  } catch (err) { $('uploadErr').textContent = err.message; }
  finally { $('uploadBtn').disabled = false; bar.style.width = 0; }
};

$('prevBtn').onclick = () => { current--; renderSong(); };
$('nextBtn').onclick = () => { current++; renderSong(); };
$('toGridBtn').onclick = () => show('grid');
$('finishBtn').onclick = () => show('done');
$('backBtn').onclick = () => show('grid');
$('logoutBtn').onclick = () => { localStorage.removeItem('mdb_session'); user = null; show('home'); };

// Resume saved session: refresh submissions from the server so other devices' uploads show up.
(async () => {
  $('mockBanner').hidden = !!API_URL;
  const saved = JSON.parse(localStorage.getItem('mdb_session') || 'null');
  if (!saved) return;
  try { login({ ...(await call('login', { email: saved.email })), email: saved.email }); }
  catch { localStorage.removeItem('mdb_session'); }
})();
