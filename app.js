// Apps Script Web App URL (see Code.gs).
const API_URL = 'https://script.google.com/macros/s/AKfycbyyVZvBLuOZz7qteS06Y6gLOIhEKL1D6PBXNP2fImdsNbf9QgwSQ7Pom1nEp65fT3z-Ow/exec';
// OAuth "Web application" client ID from Google Cloud Console; same value as GOOGLE_CLIENT_ID in Code.gs.
const GOOGLE_CLIENT_ID = '593857897186-p3hjif0elcd9ouk2u5j62kmf4rnl2m3p.apps.googleusercontent.com';

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
let user = null;    // { name, email, session, subs: { [songIndex]: fileName } }
let pending = null; // after Google sign-in, before a new user finishes sign-up: { session, email }
let current = 0;

// ---------- API (Apps Script) ----------
// Every request carries the session id the server issued at Google sign-in; the server works out the email from it.
async function call(action, data) {
  const session = user?.session || pending?.session;
  // text/plain avoids a CORS preflight, which Apps Script can't answer.
  const send = () => fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action, session, ...data }) }).then((r) => r.json());
  // Apps Script answers with a Google error page (seen as a network/CORS failure) when more than 30 requests run at once.
  // Up to 2 quiet retries, waiting ~1.5 s then ~3 s plus a random extra, so a crowd's retries don't all land together.
  // Safe for every action: register finds the existing folder (worst case an extra consent record), the rest are repeatable.
  let json;
  for (const wait of [0, 1500, 3000]) {
    if (wait) await new Promise((ok) => setTimeout(ok, wait + Math.random() * wait * 0.5));
    try { json = await send(); break; } catch { /* try again */ }
  }
  if (!json) throw new Error('Koneksi bermasalah. Periksa internetmu, lalu coba lagi.');
  if (json.error && /Sesi berakhir/.test(json.error) && action !== 'login') signOut(true); // sessions last 6 h: ask to sign in again
  if (json.error) throw new Error(json.error);
  return json;
}

// Puts a button in its loading state (spinner + text) while a request runs; also stops double sign-ups.
function busy(b, on, label = 'Memproses…') {
  if (on) { b.dataset.label = b.textContent; b.textContent = label; } else b.textContent = b.dataset.label;
  b.disabled = on;
  b.classList.toggle('loading', on);
  b.setAttribute('aria-busy', on);
}

function putFile(url, file, onProgress) {
  return new Promise((ok, fail) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress((e.loaded / e.total) * 100);
    // Drive answers the finished upload with the new file's details; its id ties the thumbnail below to this exact file.
    const id = () => { try { return JSON.parse(xhr.responseText).id || null; } catch { return null; } };
    xhr.onload = () => (xhr.status < 300 ? ok(id()) : fail(new Error('Upload gagal (' + xhr.status + ')')));
    xhr.onerror = () => fail(new Error('Koneksi terputus, coba lagi.'));
    xhr.send(file);
  });
}

// A small JPEG of the upload (a frame about 1 s in, for videos), saved next to it so later visits show the person's
// own thumbnail straight away. Resolves null if this browser can't decode the file (e.g. an iPhone HEVC .mov on desktop);
// then Drive's own thumbnail is used once it's ready.
function posterFrom(file) {
  return new Promise((ok) => {
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); URL.revokeObjectURL(url); ok(r); };
    const timer = setTimeout(() => done(null), 8000);
    const draw = (el, w, h) => {
      if (!w || !h) return done(null);
      const s = Math.min(1, 480 / Math.max(w, h)), c = document.createElement('canvas');
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
      done(c.toDataURL('image/jpeg', 0.7));
    };
    if (file.type.startsWith('image/')) {
      const img = new Image();
      img.onload = () => draw(img, img.naturalWidth, img.naturalHeight);
      img.onerror = () => done(null);
      img.src = url;
      return;
    }
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 0) / 3); };
    v.onseeked = () => draw(v, v.videoWidth, v.videoHeight);
    v.onerror = () => done(null);
    v.src = url;
  });
}

// ---------- Views ----------
// Smooth screen changes: browsers with View Transitions fade between the old and new screen (CSS: ::view-transition-*);
// older browsers, and people who ask for less motion, just switch instantly.
function transition(change) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return change();
  document.startViewTransition(change);
}

function show(view) {
  transition(() => {
    for (const v of ['home', 'grid', 'song', 'done']) $('v-' + v).hidden = v !== view;
    document.body.dataset.view = view; // home shows the big logo, other screens a small one
    if (view === 'grid') renderGrid();
    if (view === 'song') renderSong();
    if (view === 'done') $('doneCount').textContent = Object.keys(user.subs).length;
    window.scrollTo(0, 0);
  });
}

const nn = (i) => String(i + 1).padStart(2, '0');
const thumb = (i) => `url('assets/thumbs/${nn(i)}.jpg')`; // song artwork, same order as SONGS

// Song page preview box, in order of preference:
//   1. the file this person uploaded during this visit, played straight from their phone (no download);
//   2. a still of what they uploaded earlier (Drive's thumbnail, fetched by the backend);
//   3. the song's example video, assets/examples/NN.mp4 (falls back to the song artwork until that file exists).
const localPreviews = {}; // song index -> { url, image } for files uploaded this visit

// Thumbnails kept in this browser, so song pages show them instantly on later visits instead of asking the backend.
// Stored per account and tied to the uploaded file's name, so a replaced upload never shows the old picture.
// shortcut: replacing a video with one of the SAME file name from another device shows the old thumbnail here
// until this browser's copy is cleared (sign-out); compare Drive file ids instead if that ever matters.
const thumbKey = () => 'mdb_thumbs:' + user.email;
const savedThumbs = () => { try { return JSON.parse(localStorage.getItem(thumbKey())) || {}; } catch { return {}; } };
function saveThumb(i, file, image) {
  const all = savedThumbs(); all[i] = { file, image };
  try { localStorage.setItem(thumbKey(), JSON.stringify(all)); } catch { /* storage full: just fetch next time */ }
}
function renderPreview(i) {
  const box = $('songMedia'), v = $('songVideo'), img = $('songImage'), label = $('songMediaLabel');
  const isImage = SONGS[i][2] === 'image', mine = isImage ? 'Gambarmu' : 'Videomu';
  v.onerror = v.onloadedmetadata = img.onload = null; // handlers from the previous song must not fire on this one
  v.pause(); v.removeAttribute('src'); v.load(); v.hidden = img.hidden = true;
  box.classList.remove('has-media'); box.style.aspectRatio = '';
  box.style.backgroundImage = `linear-gradient(rgba(10, 8, 7, .1), rgba(10, 8, 7, .5)), ${thumb(i)}`;
  const fit = (w, h) => w && h && (box.style.aspectRatio = `${w} / ${h}`); // vertical phone videos stay tall
  const showVideo = (src, text, poster = '') => {
    v.poster = poster; v.src = src; v.hidden = false; box.classList.add('has-media'); label.textContent = text;
    v.onloadedmetadata = () => fit(v.videoWidth, v.videoHeight);
    v.onerror = () => { // missing or unplayable here: show the upload's own thumbnail if we have one, else the artwork
      v.hidden = true; box.classList.remove('has-media'); box.style.aspectRatio = '';
      if (localPreviews[i]?.poster) showImage(localPreviews[i].poster, text);
    };
  };
  const showImage = (src, text) => {
    img.src = src; img.hidden = false; box.classList.add('has-media'); label.textContent = text;
    img.onload = () => fit(img.naturalWidth, img.naturalHeight);
  };
  const local = localPreviews[i];
  if (local) return local.image ? showImage(local.url, mine) : showVideo(local.url, mine);
  if (user?.subs[i] != null) {
    label.textContent = `${mine} terkirim ✓`;
    const kept = savedThumbs()[i];
    if (kept?.file === user.subs[i]) return showImage(kept.image, `${mine} ✓`); // instant, no backend call
    const file = user.subs[i];
    call('preview', { song: i }).then(({ image }) => {
      if (!image || !user) return;
      saveThumb(i, file, image);
      if (current === i && !localPreviews[i] && !$('v-song').hidden) showImage(image, `${mine} ✓`);
    }).catch(() => {}); // no still yet (Drive still processing) or offline: the artwork stays
    return;
  }
  showVideo(`assets/examples/${nn(i)}.mp4`, 'Contoh video', `assets/thumbs/${nn(i)}.jpg`);
}

function renderGrid() {
  $('userName').textContent = user.name;
  $('count').textContent = Object.keys(user.subs).length;
  $('grid').innerHTML = '';
  SONGS.forEach(([title], i) => {
    const has = user.subs[i] != null;
    const tile = document.createElement('div');
    tile.className = 'tile' + (has ? ' has' : '');
    tile.innerHTML = `<button class="box"><span class="no"></span><span class="t"></span></button><button class="btn small ${has ? 'done' : ''}">${has ? 'Ganti?' : 'Unggah'}</button>`;
    tile.querySelector('.no').textContent = String(i + 1).padStart(2, '0');
    tile.querySelector('.box').style.backgroundImage = thumb(i);
    tile.querySelector('.t').textContent = title.replace(/\s*\(ft\..*\)$/i, ''); // "ft." names don't fit a tile; full title is on the song page
    tile.querySelector('.box').setAttribute('aria-label', `${i + 1}. ${title}${has ? ' (terkirim)' : ''}`);
    tile.querySelectorAll('button').forEach((b) => (b.onclick = () => { current = i; show('song'); }));
    $('grid').append(tile);
  });
}

function renderSong() {
  const [title, prompt] = SONGS[current];
  const n = String(current + 1).padStart(2, '0');
  $('songNo').textContent = n;
  renderPreview(current);
  $('songTitle').textContent = title;
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
  user = { name: data.name, email: data.email, session: data.session, subs: data.subs || {} };
  pending = null;
  localStorage.setItem('mdb_session', JSON.stringify({ name: user.name, email: user.email, session: user.session }));
}

// Forget the signed-in user on this device; `expired` = the server's 6-hour session ran out, so offer sign-in again.
function signOut(expired) {
  // Tapping "Keluar" also removes their thumbnails, so nothing of theirs stays on a shared device.
  // A session that merely ran out keeps them: it's the same person, about to sign straight back in.
  if (user && !expired) localStorage.removeItem(thumbKey());
  user = null; pending = null;
  for (const k in localPreviews) { URL.revokeObjectURL(localPreviews[k].url); delete localPreviews[k]; } // next person on this device
  localStorage.removeItem('mdb_session');
  window.google?.accounts?.id?.disableAutoSelect();
  show('home');
  if (expired) openPopup();
}

// ---------- Google sign-in ----------
// Instagram, TikTok, Facebook, LINE, X etc. open links in their own browser, where Google refuses to sign in.
const IN_APP = /Instagram|FBAN|FBAV|FB_IAB|TikTok|musical_ly|BytedanceWebview|Line\/|Twitter|LinkedInApp|Snapchat|; wv\)/i.test(navigator.userAgent);

function openPopup() {
  $('googleStep').hidden = false; $('regForm').hidden = true;
  $('authErr').textContent = ''; $('authBusy').hidden = true;
  $('inApp').hidden = !IN_APP; $('gBtn').hidden = IN_APP;
  if (IN_APP && /Android/i.test(navigator.userAgent)) { // Android can hand the page to Chrome directly
    $('openChrome').href = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;
    $('openChrome').hidden = false;
  }
  if (!$('consent').open) $('consent').showModal();
  $('consent').scrollTop = 0;
  renderGoogleButton();
}

// The Google library loads in the background; draw its button when both it and the pop-up are ready.
function renderGoogleButton() {
  if (IN_APP || !window.google?.accounts?.id || !$('consent').open) return;
  if (!renderGoogleButton.ready) { // Google expects initialize() once per page; later opens only redraw the button
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleSignIn, ux_mode: 'popup', context: 'signin' });
    renderGoogleButton.ready = true;
  }
  google.accounts.id.renderButton($('gBtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 280, locale: 'id' });
}
window.onGoogleLibraryLoad = renderGoogleButton;

async function onGoogleSignIn({ credential }) {
  $('authErr').textContent = ''; $('gBtn').hidden = true; $('authBusy').hidden = false;
  try {
    const res = await call('auth', { idToken: credential });
    if (res.registered) { login(res); $('consent').close(); show('grid'); return; }
    // New here: ask for their name and consent. The email shown is the one Google confirmed.
    pending = { session: res.session, email: res.email };
    $('regEmail').textContent = $('cEmail').textContent = res.email;
    $('regForm').name.value = res.googleName; $('cName').textContent = res.googleName || '—';
    const f = $('regForm'); f.agree.checked = false; f.agree.disabled = true; $('scrollHint').hidden = false; $('consentText').scrollTop = 0;
    $('googleStep').hidden = true; f.hidden = false;
    checkConsentRead();
  } catch (err) { $('authErr').textContent = err.message; $('gBtn').hidden = false; }
  finally { $('authBusy').hidden = true; }
}

$('copyLink').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); $('copyLink').textContent = 'Link disalin ✓'; }
  catch { prompt('Salin link ini, lalu buka di Chrome atau Safari:', location.href); }
};

// ---------- Events ----------
$('startBtn').onclick = () => (user ? show('grid') : openPopup());
// Consent: tick box unlocks only once the statement is scrolled to the end; name/email echo into the statement.
function checkConsentRead() {
  if ($('regForm').hidden) return; // a hidden box measures 0 tall and would count as "read"
  const c = $('consentText');
  if (c.scrollTop + c.clientHeight >= c.scrollHeight - 8) { $('regForm').agree.disabled = false; $('scrollHint').hidden = true; }
}
$('consentText').onscroll = checkConsentRead;
$('consent').addEventListener('toggle', checkConsentRead); // in case it all fits without scrolling
$('regForm').name.oninput = (e) => ($('cName').textContent = e.target.value.trim() || '—');
// Tap anywhere outside the card closes the pop-up. Outside taps land on the <dialog> itself (its backdrop);
// keyboard "clicks" land on the button inside, so they never close it. Not while a sign-up/login is still sending.
$('consent').addEventListener('click', (e) => {
  const d = e.currentTarget, r = d.getBoundingClientRect();
  const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (e.target === d && outside && !d.querySelector('.loading')) d.close();
});
$('regForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target, name = f.name.value.trim(), { session, email } = pending;
  $('regErr').textContent = ''; busy(f.querySelector('[type=submit]'), true);
  try {
    // Server saves its own copy of the statement; the version proves this page showed that same copy.
    const consentVersion = $('consentText').dataset.version;
    const res = await call('register', { name, agreed: f.agree.checked, consentVersion });
    login({ ...res, email, session });
    $('consent').close(); show('grid');
  } catch (err) { $('regErr').textContent = err.message; }
  finally { busy(f.querySelector('[type=submit]'), false); }
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
    const { uploadUrl } = await call('startUpload', { song, fileName: file.name, mimeType: file.type, size: file.size });
    const fileId = await putFile(uploadUrl, file, (p) => (bar.style.width = p + '%'));
    await call('finishUpload', { song }).catch(() => {}); // cleanup only; the new file is already saved
    if (!user) return; // signed out meanwhile (session ended): the file is saved in Drive and shows after signing in again
    user.subs[song] = file.name;
    if (localPreviews[song]) URL.revokeObjectURL(localPreviews[song].url);
    localPreviews[song] = { url: URL.createObjectURL(file), image: file.type.startsWith('image/') };
    if (current === song) renderSong();
    // In the background: save a thumbnail of this upload for later visits (and use it here if the video can't play).
    posterFrom(file).then((image) => {
      if (!image) return;
      if (localPreviews[song]) localPreviews[song].poster = image;
      if (user) saveThumb(song, file.name, image);
      if (fileId) call('savePreview', { song, fileId, image }).catch(() => {});
    });
  } catch (err) { $('uploadErr').textContent = err.message; }
  finally { $('uploadBtn').disabled = false; bar.style.width = 0; }
};

$('prevBtn').onclick = () => transition(() => { current--; renderSong(); });
$('nextBtn').onclick = () => transition(() => { current++; renderSong(); });
$('toGridBtn').onclick = () => show('grid');
$('finishBtn').onclick = () => show('done');
$('backBtn').onclick = () => show('grid');
$('logoutBtn').onclick = () => { call('logout').catch(() => {}); signOut(false); };

// Resume saved session: refresh submissions from the server so other devices' uploads show up.
(async () => {
  const saved = JSON.parse(localStorage.getItem('mdb_session') || 'null');
  if (!saved?.session) return localStorage.removeItem('mdb_session'); // saved before Google sign-in existed
  busy($('startBtn'), true, 'Memuat…'); // otherwise a tap here mid-sign-in opens the sign-up form
  try { user = saved; login({ ...(await call('login')), email: saved.email, session: saved.session }); }
  catch (err) { user = null; if (/Sesi berakhir|belum terdaftar/.test(err.message)) localStorage.removeItem('mdb_session'); } // keep it on a connection blip
  finally { busy($('startBtn'), false); }
})();
