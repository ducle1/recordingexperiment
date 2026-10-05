/* Sổ Ghi Âm — ghi âm từ micro, đo mức vào, lưu, phát lại và tải bản ghi.
   Cần nạp sau format.js, storage.js, wav.js (xem thứ tự thẻ <script defer> trong index.html). */
(function () {
'use strict';

const SGA = window.SGA || {};
if (!SGA.format || !SGA.storage || !SGA.wav) {
  const box = document.getElementById('notice');
  if (box) {
    box.textContent = 'Thiếu file JS trong thư mục js/ (format.js, storage.js, wav.js). Hãy giữ nguyên cấu trúc thư mục khi upload.';
    box.dataset.kind = 'error';
    box.hidden = false;
  }
  return;
}
const {
  FLOOR, fmtTime, fmtSize, fmtDate, fmtDb, fmtKHz, toDb, norm, uid,
  codecLabel, extFor, pickMime, fileName,
} = SGA.format;
const { settings, saveSettings, DB } = SGA.storage;
const { toWav } = SGA.wav;

const $ = (s, r = document) => r.querySelector(s);
const els = {
  rec: $('#btn-rec'), lblRec: $('#lbl-rec'),
  pause: $('#btn-pause'), lblPause: $('#lbl-pause'),
  discard: $('#btn-discard'), lblDiscard: $('#lbl-discard'),
  status: $('#status'), statusText: $('#status-text'), specs: $('#specs'),
  time: $('#timecode'), canvas: $('#wave'),
  fill: $('#meter-fill'), peak: $('#meter-peak'), readout: $('#peak-readout'), clip: $('#clip'), scale: $('#meter-scale'),
  notice: $('#notice'),
  mic: $('#mic-select'), micHint: $('#mic-hint'), clean: $('#opt-clean'), agc: $('#opt-agc'),
  list: $('#take-list'), summary: $('#takes-summary'),
};
const APP = 'Sổ Ghi Âm';
const BITRATE = 128000;
const BAR_MS = 50;                       // mỗi cột dạng sóng = 50 ms
const SCALE = [-60, -40, -24, -18, -12, -6, 0];
const SHARE_OK = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
// Trình duyệt nhúng trong Zalo, Facebook, Messenger, Instagram, TikTok… thường chặn tải file và micro
const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Zalo|Line\/|MicroMessenger|TikTok|musical_ly/i.test(navigator.userAgent || '');
// iPhone khi mở từ biểu tượng ngoài màn hình chính: không có trình quản lý tải về, phải lưu qua bảng chia sẻ
const IOS_STANDALONE = window.navigator.standalone === true;
const IN_APP_MSG = 'Bạn đang mở trang trong trình duyệt của Zalo / Facebook, nơi thường chặn tải file và micro. Bấm menu ⋯ và chọn "Mở bằng trình duyệt" (Chrome hoặc Safari).';

/* ---------- thông báo ---------- */
let problem = '';
function showNotice(msg, kind = 'info') {
  els.notice.textContent = msg;
  els.notice.dataset.kind = kind;
  els.notice.hidden = false;
}
function clearNotice() { if (!problem) els.notice.hidden = true; }

/* ---------- lưu trữ ---------- */
let persist = true;
let askedPersist = false;
function storageFailed() {
  if (!persist) return;
  persist = false;
  showNotice('Không lưu được vào bộ nhớ trình duyệt (có thể đang ở chế độ ẩn danh hoặc hết dung lượng). Bản ghi chỉ còn đến khi bạn đóng trang, hãy tải về bản cần giữ.');
}
async function persistPut(r) {
  if (!persist) return;
  try {
    await DB.put(r);
    if (!askedPersist && navigator.storage && navigator.storage.persist) {
      askedPersist = true;
      navigator.storage.persist().catch(() => {});   // xin trình duyệt đừng tự xóa dữ liệu
    }
  } catch (e) { storageFailed(); }
}

/* ---------- trạng thái máy ghi ---------- */
const rec = {
  state: 'idle', stream: null, mr: null, chunks: [], mime: '', ctx: null, analyser: null, buf: null,
  raf: 0, acc: 0, startedAt: 0, lastBar: 0, accPeak: 0, peaks: [], bars: 0,
  sampleRate: 0, discard: false, finishing: false, wake: null,
};
let discardTimer = 0;
let lastTitleSec = -1;

function supportProblem() {
  if (window.isSecureContext === false) return 'Trình duyệt chỉ cho dùng micro khi trang chạy qua HTTPS (hoặc localhost). Hãy mở trang bằng địa chỉ https://.';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return 'Trình duyệt này không hỗ trợ ghi âm. Hãy dùng Chrome, Edge, Firefox hoặc Safari bản mới.';
  return '';
}
const isActive = () => rec.state === 'recording' || rec.state === 'paused';
const elapsed = now => (rec.state === 'recording' ? rec.acc + ((now || performance.now()) - rec.startedAt) : rec.acc);

function describeError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') return 'Trang chưa được phép dùng micro. Bấm biểu tượng ổ khóa cạnh thanh địa chỉ, cho phép Micro, rồi bấm Ghi lần nữa.';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'Không tìm thấy micro nào. Cắm micro hoặc tai nghe có mic rồi thử lại.';
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'Micro đang bị ứng dụng khác dùng (Zoom, Meet, Zalo…). Đóng ứng dụng đó rồi thử lại.';
  if (n === 'OverconstrainedError') return 'Micro đã chọn không còn kết nối. Chọn micro khác trong danh sách.';
  if (n === 'NotSupportedError') return 'Trình duyệt không ghi được định dạng âm thanh này. Hãy thử Chrome hoặc Safari bản mới.';
  return 'Không bật được micro' + (e && e.message ? ': ' + e.message : '.');
}

async function openMic() {
  const audio = { echoCancellation: settings.clean, noiseSuppression: settings.clean, autoGainControl: settings.agc };
  if (settings.deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: settings.deviceId } } });
    } catch (e) {
      if (!(e && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError'))) throw e;
      settings.deviceId = ''; saveSettings();   // micro đã rút ra: quay về micro mặc định
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio });
}

async function startRecording() {
  if (rec.state !== 'idle' || problem) return;
  clearNotice();
  player.pause();
  rec.state = 'starting';
  updateUI();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  try { ctx = Ctx ? new Ctx() : null; } catch (e) { ctx = null; }   // tạo ngay trong cú bấm để Safari không chặn
  try {
    const stream = await openMic();
    rec.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (track) track.addEventListener('ended', onTrackEnded);
    refreshDevices();
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      rec.ctx = ctx; rec.analyser = an; rec.buf = new Float32Array(an.fftSize);
    }
    const ts = track && track.getSettings ? track.getSettings() : {};
    rec.sampleRate = ts.sampleRate || (ctx && ctx.sampleRate) || 0;
    rec.mime = pickMime();
    const opts = { audioBitsPerSecond: BITRATE };
    if (rec.mime) opts.mimeType = rec.mime;
    const mr = new MediaRecorder(stream, opts);
    rec.mr = mr; rec.chunks = []; rec.discard = false; rec.finishing = false;
    mr.ondataavailable = e => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    mr.onstop = finalize;
    mr.onerror = () => { showNotice('Trình duyệt dừng ghi âm do lỗi. Phần đã ghi (nếu có) được lưu lại.', 'error'); stopRecording(); };
    rec.peaks = []; rec.bars = 0; rec.accPeak = 0;
    mr.start(1000);
    const now = performance.now();
    rec.acc = 0; rec.startedAt = now; rec.lastBar = now;
    rec.state = 'recording';
    lastTitleSec = -1;
    requestWakeLock();
    updateUI();
    cancelAnimationFrame(rec.raf);
    loop();
  } catch (e) {
    if (ctx && rec.ctx !== ctx) { try { ctx.close(); } catch (err) { /* bỏ qua */ } }
    cleanupStream();
    rec.mr = null; rec.state = 'idle';
    updateUI();
    showNotice(describeError(e), 'error');
  }
}

function togglePause() {
  if (!rec.mr) return;
  const now = performance.now();
  if (rec.state === 'recording') {
    try { rec.mr.pause(); } catch (e) { return; }
    rec.acc += now - rec.startedAt;
    rec.state = 'paused';
  } else if (rec.state === 'paused') {
    try { rec.mr.resume(); } catch (e) { return; }
    rec.startedAt = now; rec.lastBar = now;
    rec.state = 'recording';
  }
  lastTitleSec = -1;
  updateUI();
}

function stopRecording() {
  if (!isActive()) return;
  if (rec.state === 'recording') rec.acc += performance.now() - rec.startedAt;
  rec.state = 'stopping';
  disarmDiscard();
  updateUI();
  try {
    if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop();
    else finalize();
  } catch (e) { finalize(); }
}

function toggleRecord() {
  if (rec.state === 'idle') startRecording();
  else if (isActive()) stopRecording();
}

function onDiscard() {
  if (!isActive()) return;
  if (!discardTimer) {                         // bấm lần 1: hỏi lại, bấm lần 2 trong 3 giây: hủy
    discardTimer = setTimeout(() => { discardTimer = 0; updateUI(); }, 3000);
    updateUI();
    return;
  }
  disarmDiscard();
  rec.discard = true;
  stopRecording();
}
function disarmDiscard() { if (discardTimer) { clearTimeout(discardTimer); discardTimer = 0; } }

function onTrackEnded() {
  if (!isActive()) return;
  showNotice('Micro bị ngắt giữa chừng. Phần đã ghi được lưu lại.');
  stopRecording();
}

function cleanupStream() {
  cancelAnimationFrame(rec.raf); rec.raf = 0;
  if (rec.stream) rec.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* bỏ qua */ } });
  rec.stream = null;
  if (rec.ctx) { try { rec.ctx.close(); } catch (e) { /* bỏ qua */ } }
  rec.ctx = null; rec.analyser = null; rec.buf = null;
  resetMeter();
}

function nextName() {
  let n = recordings.length;
  for (const r of recordings) {
    const m = /^Bản ghi (\d+)$/.exec(r.name || '');
    if (m) n = Math.max(n, +m[1]);
  }
  return 'Bản ghi ' + (n + 1);
}

async function finalize() {
  if (rec.finishing) return;
  rec.finishing = true;
  const mr = rec.mr;
  const type = (mr && mr.mimeType) || rec.mime || 'audio/webm';
  const blob = new Blob(rec.chunks, { type });
  const duration = rec.acc;
  const discarded = rec.discard;
  cleanupStream();
  releaseWakeLock();
  rec.mr = null; rec.chunks = []; rec.state = 'idle'; rec.discard = false; rec.acc = 0;
  if (discarded) { rec.peaks = []; rec.bars = 0; }
  els.time.textContent = fmtTime(0, true);
  document.title = APP;
  updateUI();
  drawWave();
  if (discarded) return;
  if (!blob.size || duration < 300) {
    showNotice('Bản ghi quá ngắn hoặc không có âm thanh nên không được lưu.');
    return;
  }
  const item = { id: uid(), name: nextName(), created: Date.now(), duration, mime: type, size: blob.size, blob };
  recordings.unshift(item);
  renderList(item.id);
  persistPut(item);
}

/* ---------- giữ màn hình sáng khi đang ghi ---------- */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    const w = await navigator.wakeLock.request('screen');
    if (!isActive()) { w.release().catch(() => {}); return; }
    rec.wake = w;
    w.addEventListener('release', () => { if (rec.wake === w) rec.wake = null; });
  } catch (e) { rec.wake = null; }
}
function releaseWakeLock() {
  const w = rec.wake;
  rec.wake = null;
  if (w) w.release().catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isActive() && !rec.wake) requestWakeLock();
});
window.addEventListener('beforeunload', e => {
  if (rec.state !== 'idle') { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- vòng vẽ: thời gian, dạng sóng, đồng hồ mức ---------- */
function loop() {
  rec.raf = requestAnimationFrame(loop);
  const now = performance.now();
  const el = elapsed(now);
  els.time.textContent = fmtTime(el, true);
  const sec = Math.floor(el / 1000);
  if (sec !== lastTitleSec) {
    lastTitleSec = sec;
    document.title = (rec.state === 'paused' ? '❚❚ ' : '● ') + fmtTime(el) + ' · ' + APP;
  }
  if (!rec.analyser) return;
  rec.analyser.getFloatTimeDomainData(rec.buf);
  let peak = 0;
  for (let i = 0; i < rec.buf.length; i++) {
    const a = Math.abs(rec.buf[i]);
    if (a > peak) peak = a;
  }
  if (rec.state === 'recording') {
    if (peak > rec.accPeak) rec.accPeak = peak;
    if (now - rec.lastBar >= BAR_MS) {
      rec.peaks.push(toDb(rec.accPeak));
      rec.bars++; rec.accPeak = 0; rec.lastBar = now;
      if (rec.peaks.length > 1600) rec.peaks.splice(0, rec.peaks.length - 1600);
    }
  }
  drawWave();
  drawMeter(peak, now);
}

const wave = { ctx: els.canvas.getContext('2d'), w: 1, h: 1, dpr: 1 };
const colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  colors.wave = v('--wave'); colors.hot = v('--hot'); colors.grid = v('--screen-line'); colors.tick = v('--screen-muted');
  drawWave();
}
function sizeCanvas() {
  const r = els.canvas.getBoundingClientRect();
  wave.dpr = Math.min(window.devicePixelRatio || 1, 2);
  wave.w = Math.max(1, Math.round(r.width * wave.dpr));
  wave.h = Math.max(1, Math.round(r.height * wave.dpr));
  els.canvas.width = wave.w;
  els.canvas.height = wave.h;
  drawWave();
}
function drawWave() {
  const c = wave.ctx;
  if (!c) return;
  const W = wave.w, H = wave.h, d = wave.dpr;
  c.globalAlpha = 1;
  c.clearRect(0, 0, W, H);
  const mid = Math.round(H / 2);
  const lw = Math.max(1, Math.round(d));
  c.fillStyle = colors.grid;
  c.fillRect(0, mid - Math.floor(lw / 2), W, lw);
  const n = rec.peaks.length;
  if (!n) return;
  const step = 4 * d, bw = Math.max(1, Math.round(2.5 * d));
  const maxH = mid - 2 * d;
  const first = rec.bars - n;
  const live = isActive();
  const visible = Math.min(n, Math.ceil(W / step) + 1);
  const tickH = Math.round(6 * d);
  for (let k = 0; k < visible; k++) {
    const i = n - 1 - k;
    const x = Math.round(W - (k + 1) * step);
    if ((first + i) % 20 === 0) {               // vạch mỗi giây (20 cột × 50 ms)
      c.globalAlpha = 1;
      c.fillStyle = colors.tick;
      c.fillRect(x, 0, lw, tickH);
    }
    const db = rec.peaks[i];
    const hh = Math.max(lw / 2, norm(db) * maxH);
    c.globalAlpha = live ? 1 : 0.45;             // bản vừa ghi xong hiện mờ
    c.fillStyle = db > -1 ? colors.hot : colors.wave;
    c.fillRect(x, Math.round(mid - hh), bw, Math.max(lw, Math.round(hh * 2)));
  }
  c.globalAlpha = 1;
}

const meter = { db: -Infinity, hold: -Infinity, holdAt: 0, last: 0, clipUntil: 0, textAt: 0 };
function setFill(pct) {
  const v = 'inset(0 ' + (100 - pct).toFixed(2) + '% 0 0)';
  els.fill.style.clipPath = v;
  els.fill.style.webkitClipPath = v;
}
function drawMeter(peakAmp, now) {
  const db = toDb(peakAmp);
  const dt = meter.last ? Math.min(0.1, (now - meter.last) / 1000) : 0;
  meter.last = now;
  meter.db = db >= meter.db ? db : Math.max(db, meter.db - 26 * dt);     // lên tức thì, rơi 26 dB/s
  if (db >= meter.hold) { meter.hold = db; meter.holdAt = now; }
  else if (now - meter.holdAt > 1500) meter.hold = Math.max(db, meter.hold - 14 * dt);
  if (peakAmp >= 0.999) meter.clipUntil = now + 2000;
  setFill(norm(meter.db) * 100);
  const hx = norm(meter.hold);
  els.peak.style.left = 'calc(' + (hx * 100).toFixed(2) + '% - 1px)';
  els.peak.style.opacity = hx > 0 ? '1' : '0';
  els.clip.classList.toggle('on', now < meter.clipUntil);
  if (now - meter.textAt > 120) {
    meter.textAt = now;
    els.readout.textContent = meter.hold > FLOOR ? 'Đỉnh ' + fmtDb(meter.hold) + ' dBFS' : 'Đỉnh < −60 dBFS';
  }
}
function resetMeter() {
  meter.db = meter.hold = -Infinity;
  meter.last = 0; meter.clipUntil = 0; meter.textAt = 0;
  setFill(0);
  els.peak.style.opacity = '0';
  els.clip.classList.remove('on');
  els.readout.textContent = 'Đỉnh — dBFS';
}
function buildScale() {
  for (const db of SCALE) {
    const s = document.createElement('span');
    s.textContent = db < 0 ? '−' + Math.abs(db) : '0';
    s.style.left = (norm(db) * 100).toFixed(3) + '%';
    els.scale.append(s);
  }
}

/* ---------- giao diện máy ghi ---------- */
const STATUS = { idle: 'Sẵn sàng', starting: 'Đang mở micro…', recording: 'Đang ghi', paused: 'Tạm dừng', stopping: 'Đang lưu…' };
function specsText() {
  const mime = (rec.mr && rec.mr.mimeType) || rec.mime || pickMime();
  const parts = [];
  if (rec.sampleRate) parts.push(fmtKHz(rec.sampleRate) + ' kHz');
  parts.push(codecLabel(mime));
  parts.push(BITRATE / 1000 + ' kbps');
  return parts.join(' · ');
}
function updateUI() {
  const s = rec.state, active = isActive();
  els.status.dataset.state = s;
  els.statusText.textContent = STATUS[s];
  els.specs.textContent = specsText();

  els.rec.classList.toggle('is-active', active);
  els.rec.disabled = !!problem || s === 'starting' || s === 'stopping';
  els.rec.setAttribute('aria-label', active ? 'Dừng và lưu' : 'Bắt đầu ghi');
  els.lblRec.textContent = s === 'starting' ? 'Đang mở micro…' : s === 'stopping' ? 'Đang lưu…' : active ? 'Dừng và lưu' : 'Ghi';

  els.pause.disabled = !active;
  els.pause.classList.toggle('is-paused', s === 'paused');
  els.lblPause.textContent = s === 'paused' ? 'Ghi tiếp' : 'Tạm dừng';
  els.pause.setAttribute('aria-label', els.lblPause.textContent);

  els.discard.disabled = !active;
  els.discard.classList.toggle('armed', !!discardTimer);
  els.lblDiscard.textContent = discardTimer ? 'Bấm lần nữa để hủy' : 'Hủy';

  const lock = s !== 'idle';
  els.mic.disabled = lock; els.clean.disabled = lock; els.agc.disabled = lock;
}

async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let list = [];
  try {
    list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  } catch (e) { return; }
  const sel = els.mic;
  sel.textContent = '';
  sel.append(new Option('Micro mặc định', ''));
  let n = 0;
  for (const d of list) {
    if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
    n++;
    sel.append(new Option(d.label || 'Micro ' + n, d.deviceId));
  }
  sel.value = list.some(d => d.deviceId === settings.deviceId) ? settings.deviceId : '';
  els.micHint.hidden = list.some(d => d.label);
}

/* ---------- phát lại ---------- */
let recordings = [];
const urls = new Map();
const byId = id => recordings.find(r => r.id === id);
function urlFor(r) {
  if (!urls.has(r.id)) urls.set(r.id, URL.createObjectURL(r.blob));
  return urls.get(r.id);
}

const player = new Audio();
player.preload = 'auto';
let currentId = null, pending = null, fixing = false;

function durOf(r) {
  if (r && r.id === currentId && isFinite(player.duration) && player.duration > 0) return player.duration * 1000;
  return (r && r.duration) || 1;
}
function load(id, t, play) {
  const r = byId(id);
  if (!r) return;
  player.pause();
  currentId = id; fixing = false;
  pending = { t: t || 0, play: !!play };
  player.src = urlFor(r);
  player.load();
  if (play) player.play().catch(() => {});   // gọi ngay trong cú bấm để Safari cho phát
  syncPlayer();
}
function applyPending() {
  const p = pending;
  pending = null;
  if (!p) return;
  try { player.currentTime = p.t; } catch (e) { /* bỏ qua */ }
  if (p.play && player.paused) player.play().catch(() => syncPlayer());
  syncPlayer();
}
player.addEventListener('loadedmetadata', () => {
  if (!pending) return;
  if (!isFinite(player.duration)) {
    // File WebM của MediaRecorder không ghi thời lượng: tua tới cuối một lần để trình duyệt tính ra, rồi mới tua được
    fixing = true;
    const done = () => { player.removeEventListener('timeupdate', done); fixing = false; applyPending(); };
    player.addEventListener('timeupdate', done);
    try { player.currentTime = 1e101; } catch (e) { player.removeEventListener('timeupdate', done); fixing = false; applyPending(); }
  } else {
    applyPending();
  }
});
['play', 'pause', 'ended', 'timeupdate'].forEach(ev => player.addEventListener(ev, () => { if (!fixing) syncPlayer(); }));
player.addEventListener('error', () => {
  if (!currentId) return;
  pending = null; fixing = false;
  showNotice('Trình duyệt không phát được bản ghi này. Hãy tải về để nghe bằng ứng dụng khác.', 'error');
  syncPlayer();
});

function togglePlay(id) {
  if (id !== currentId) { load(id, 0, true); return; }
  if (pending) {
    pending.play = !pending.play;
    if (pending.play) player.play().catch(() => {}); else player.pause();
    syncPlayer();
    return;
  }
  if (player.paused || player.ended) player.play().catch(() => {});
  else player.pause();
}
function setProgress(row, tMs, dur) {
  const f = Math.max(0, Math.min(1, tMs / dur));
  const seek = $('.seek', row);
  seek.value = Math.round(f * 1000);
  seek.style.setProperty('--p', (f * 100).toFixed(2) + '%');
  $('.take-time', row).textContent = fmtTime(tMs) + ' / ' + fmtTime(dur);
}
function syncPlayer() {
  els.list.querySelectorAll('.take').forEach(row => {
    const cur = row.dataset.id === currentId;
    const playing = cur && (pending ? pending.play : (!player.paused && !player.ended));
    row.classList.toggle('is-playing', playing);
    $('.play', row).setAttribute('aria-label', playing ? 'Tạm dừng' : 'Phát');
  });
  if (currentId && !pending && !fixing) {
    const row = els.list.querySelector('.take[data-id="' + currentId + '"]');
    const r = byId(currentId);
    if (row && r) setProgress(row, player.currentTime * 1000, durOf(r));
  }
}
function seekInput(input) {
  const row = input.closest('.take');
  const id = row.dataset.id;
  const r = byId(id);
  if (!r) return;
  const dur = durOf(r);
  const tMs = (input.value / 1000) * dur;
  setProgress(row, tMs, dur);
  if (id === currentId) {
    if (pending) pending.t = tMs / 1000;
    else if (!fixing) { try { player.currentTime = tMs / 1000; } catch (e) { /* bỏ qua */ } }
  } else {
    load(id, tMs / 1000, false);
  }
}

/* ---------- danh sách bản ghi ---------- */
const ICON_PLAY = '<svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.8v12.4a.8.8 0 0 0 1.2.7l9.6-6.2a.8.8 0 0 0 0-1.4L9.7 5.1a.8.8 0 0 0-1.2.7z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
const ROW_HTML =
  '<button class="play" type="button" aria-label="Phát">' + ICON_PLAY + ICON_PAUSE + '</button>' +
  '<div class="take-main">' +
    '<div class="take-head"><input class="take-name" type="text" maxlength="80" spellcheck="false" aria-label="Tên bản ghi"><span class="take-meta"></span></div>' +
    '<div class="take-track"><input class="seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Vị trí phát"><span class="take-time"></span></div>' +
    '<div class="take-actions">' +
      '<button class="act dl" type="button"></button>' +
      '<button class="act wav" type="button">Tải .wav</button>' +
      '<button class="act share" type="button" hidden>Chia sẻ</button>' +
      '<button class="act del" type="button">Xóa</button>' +
    '</div>' +
  '</div>';

function buildRow(r, isNew) {
  const li = document.createElement('li');
  li.className = 'take' + (isNew ? ' is-new' : '');
  li.dataset.id = r.id;
  li.innerHTML = ROW_HTML;
  const name = $('.take-name', li);
  name.id = 'name-' + r.id;
  name.value = r.name;
  $('.seek', li).id = 'seek-' + r.id;
  $('.take-meta', li).textContent = fmtDate(r.created) + ' · ' + fmtSize(r.size) + ' · ' + codecLabel(r.mime);
  $('.take-time', li).textContent = '00:00 / ' + fmtTime(r.duration);
  const ext = extFor(r.mime);
  $('.dl', li).textContent = 'Tải .' + ext;
  if (ext === 'wav') $('.wav', li).hidden = true;
  if (SHARE_OK) $('.share', li).hidden = false;
  return li;
}
function renderList(newId) {
  const ul = els.list;
  ul.textContent = '';
  if (!recordings.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.innerHTML = '<strong>Chưa có bản ghi nào.</strong> Bấm nút đỏ để bắt đầu. Khi bạn dừng, bản ghi hiện ở đây để nghe lại, đổi tên và tải về.';
    ul.append(li);
    els.summary.textContent = '';
    return;
  }
  for (const r of recordings) ul.append(buildRow(r, r.id === newId));
  const total = recordings.reduce((s, r) => s + (r.size || 0), 0);
  const totalMs = recordings.reduce((s, r) => s + (r.duration || 0), 0);
  els.summary.textContent = recordings.length + ' bản ghi · ' + fmtTime(totalMs) + ' · ' + fmtSize(total);
  syncPlayer();
}

/* ---------- tải về và chia sẻ ---------- */
// Link blob được giữ tới khi xóa bản ghi. Bản trước thu hồi link sau 5 giây, nên trên iPhone
// (Safari hỏi "Tải về?" và chờ người dùng bấm) file không tải được nếu bấm chậm.
const wavCache = new Map();   // id → Blob WAV đã chuyển, bấm lại không phải chuyển lần nữa
function wavUrl(r) {
  const key = r.id + ':wav';
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(wavCache.get(r.id)));
  return urls.get(key);
}
function revokeFor(id) {
  for (const key of [id, id + ':wav']) {
    const u = urls.get(key);
    if (u) { URL.revokeObjectURL(u); urls.delete(key); }
  }
  wavCache.delete(id);
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 0);
}

/** Tìm tên file mà bảng chia sẻ của máy chấp nhận (Android cần .weba cho WebM âm thanh) */
function shareableFile(blob, base, ext) {
  if (!SHARE_OK) return null;
  const type = blob.type || 'application/octet-stream';
  const names = ext === 'webm' ? [base + '.webm', base + '.weba'] : [base + '.' + ext];
  return names
    .map(n => new File([blob], n, { type }))
    .find(f => { try { return navigator.canShare({ files: [f] }); } catch (e) { return false; } }) || null;
}

async function shareFile(file, title) {
  try {
    await navigator.share({ files: [file], title });
    return true;
  } catch (e) {
    if (e && e.name === 'AbortError') return true;          // người dùng tự đóng bảng chia sẻ
    if (e && e.name === 'NotAllowedError') showNotice('Bấm nút lần nữa để mở bảng chia sẻ.');
    else showNotice('Không mở được bảng chia sẻ. Hãy dùng nút Tải.', 'error');
    return false;
  }
}

/** Giao file cho người dùng theo cách thiết bị hỗ trợ */
function deliver(blob, url, base, ext, title) {
  if (IOS_STANDALONE) {
    const f = shareableFile(blob, base, ext);
    if (f) { shareFile(f, title); return; }
  }
  triggerDownload(url, base + '.' + ext);
  if (IN_APP) showNotice(IN_APP_MSG, 'error');
}

function downloadOriginal(r) {
  deliver(r.blob, urlFor(r), fileName(r), extFor(r.mime), r.name);
}

async function downloadWav(r, btn) {
  if (!wavCache.has(r.id)) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Đang chuyển…';
    try {
      wavCache.set(r.id, await toWav(r.blob));
    } catch (e) {
      showNotice('Không chuyển được sang WAV trên trình duyệt này. Hãy tải bản gốc.', 'error');
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
  deliver(wavCache.get(r.id), wavUrl(r), fileName(r), 'wav', r.name);
}

function shareTake(r) {
  const ext = extFor(r.mime);
  const f = shareableFile(r.blob, fileName(r), ext);
  if (!f) {
    showNotice('Thiết bị này không chia sẻ được file .' + ext + '. Hãy dùng nút Tải.', 'error');
    return;
  }
  shareFile(f, r.name);
}

function armDelete(r, btn) {
  if (btn.classList.contains('confirm')) {
    clearTimeout(btn._t);
    removeTake(r.id);
    return;
  }
  btn.classList.add('confirm');
  btn.textContent = 'Xóa hẳn?';
  btn._t = setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = 'Xóa'; }, 3000);
}
async function removeTake(id) {
  if (currentId === id) {
    currentId = null; pending = null; fixing = false;
    player.pause();
    player.removeAttribute('src');
    player.load();
  }
  revokeFor(id);
  recordings = recordings.filter(r => r.id !== id);
  renderList();
  if (persist) { try { await DB.del(id); } catch (e) { storageFailed(); } }
}
function renameTake(input) {
  const r = byId(input.closest('.take').dataset.id);
  if (!r) return;
  const v = input.value.trim().replace(/\s+/g, ' ');
  if (!v) { input.value = r.name; return; }
  r.name = v;
  input.value = v;
  persistPut(r);
}

els.list.addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const row = btn.closest('.take');
  if (!row) return;
  const r = byId(row.dataset.id);
  if (!r) return;
  if (btn.classList.contains('play')) togglePlay(r.id);
  else if (btn.classList.contains('dl')) downloadOriginal(r);
  else if (btn.classList.contains('wav')) downloadWav(r, btn);
  else if (btn.classList.contains('share')) shareTake(r);
  else if (btn.classList.contains('del')) armDelete(r, btn);
});
els.list.addEventListener('input', e => { if (e.target.classList.contains('seek')) seekInput(e.target); });
els.list.addEventListener('change', e => { if (e.target.classList.contains('take-name')) renameTake(e.target); });
els.list.addEventListener('keydown', e => {
  if (!e.target.classList.contains('take-name')) return;
  if (e.key === 'Enter') e.target.blur();
  else if (e.key === 'Escape') {
    const r = byId(e.target.closest('.take').dataset.id);
    if (r) e.target.value = r.name;
    e.target.blur();
  }
});

/* ---------- điều khiển ---------- */
els.rec.addEventListener('click', toggleRecord);
els.pause.addEventListener('click', togglePause);
els.discard.addEventListener('click', onDiscard);
els.mic.addEventListener('change', () => { settings.deviceId = els.mic.value; saveSettings(); });
els.clean.addEventListener('change', () => { settings.clean = els.clean.checked; saveSettings(); });
els.agc.addEventListener('change', () => { settings.agc = els.agc.checked; saveSettings(); });
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const t = e.target, tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || (t && t.isContentEditable)) return;
  if (e.code === 'Space') { e.preventDefault(); toggleRecord(); }
  else if ((e.key === 'p' || e.key === 'P') && isActive()) { e.preventDefault(); togglePause(); }
});

/* ---------- khởi động ---------- */
async function loadTakes() {
  try {
    const all = await DB.all();
    recordings = (all || []).filter(r => r && r.blob).sort((a, b) => b.created - a.created);
  } catch (e) {
    persist = false;
    if (!problem) showNotice('Trình duyệt này không cho lưu bản ghi lâu dài. Bản ghi chỉ còn đến khi bạn đóng trang, hãy tải về bản cần giữ.');
  }
  renderList();
}

function init() {
  els.clean.checked = !!settings.clean;
  els.agc.checked = !!settings.agc;
  buildScale();
  const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', readColors);
  if (window.MutationObserver) {
    new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  readColors();
  if ('ResizeObserver' in window) new ResizeObserver(sizeCanvas).observe(els.canvas);
  else window.addEventListener('resize', sizeCanvas);
  sizeCanvas();
  problem = supportProblem();
  if (problem) showNotice(problem, 'error');
  else if (IN_APP) showNotice(IN_APP_MSG, 'error');
  resetMeter();
  updateUI();
  renderList();
  loadTakes();
  refreshDevices();
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }
  // Cài được như app trên điện thoại và mở được khi mất mạng
  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

init();
})();
