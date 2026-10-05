/* Sổ Ghi Âm — định dạng thời gian, dung lượng, mức dB và nhận diện định dạng âm thanh.
   Script thường (không phải module) để chạy được cả khi mở file trực tiếp. */
(function (SGA) {
  'use strict';

  const FLOOR = -60; // đáy thang đo mức vào (dBFS)

  const pad = n => String(n).padStart(2, '0');

  const nf1 = new Intl.NumberFormat('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nfK = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

  /** 65400 → "01:05" ; với tenths → "01:05.4" */
  function fmtTime(ms, tenths) {
    const t = Math.max(0, ms || 0) / 1000;
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    let out = (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s);
    if (tenths) out += '.' + (Math.floor(t * 10) % 10);
    return out;
  }

  const fmtSize = b =>
    b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : nf1.format(b / 1048576) + ' MB';

  const fmtDate = ts => {
    const d = new Date(ts);
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };

  const fmtDb = db => (db < 0 ? '−' : '') + nf1.format(Math.abs(db));
  const fmtKHz = hz => nfK.format(hz / 1000);

  const toDb = a => (a > 0 ? 20 * Math.log10(a) : -Infinity);
  /** dBFS → 0..1 trên thang FLOOR..0 */
  const norm = db => (db <= FLOOR ? 0 : db >= 0 ? 1 : (db - FLOOR) / -FLOOR);

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function codecLabel(mime) {
    const m = (mime || '').toLowerCase();
    if (m.includes('opus')) return 'Opus';
    if (m.includes('mp4') || m.includes('aac')) return 'AAC';
    if (m.includes('wav')) return 'WAV';
    if (m.includes('ogg')) return 'Ogg';
    if (m.includes('webm')) return 'WebM';
    return 'Âm thanh';
  }

  function extFor(mime) {
    const m = (mime || '').toLowerCase();
    if (m.includes('mp4') || m.includes('aac')) return 'm4a';
    if (m.includes('ogg')) return 'ogg';
    if (m.includes('wav')) return 'wav';
    return 'webm';
  }

  /** Định dạng tốt nhất trình duyệt ghi được: Chrome/Firefox → WebM Opus, Safari → MP4 AAC */
  function pickMime() {
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    const list = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    return list.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } }) || '';
  }

  /** Tên file an toàn cho mọi hệ điều hành, giữ nguyên tiếng Việt */
  const fileName = r => (r.name || '').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'ghi-am';

  SGA.format = {
    FLOOR, pad, fmtTime, fmtSize, fmtDate, fmtDb, fmtKHz, toDb, norm, uid,
    codecLabel, extFor, pickMime, fileName,
  };
})(window.SGA = window.SGA || {});
