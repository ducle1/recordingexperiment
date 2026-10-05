/* Sổ Ghi Âm — chuyển bản ghi (WebM/MP4) sang WAV PCM 16-bit ngay trong trình duyệt. */
(function (SGA) {
  'use strict';

  function encodeWav(buf) {
    const ch = Math.min(buf.numberOfChannels, 2);
    const len = buf.length;
    const sr = buf.sampleRate;
    const bytes = len * ch * 2;
    const view = new DataView(new ArrayBuffer(44 + bytes));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };

    w(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); w(8, 'WAVE');
    w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * ch * 2, true);
    view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
    w(36, 'data'); view.setUint32(40, bytes, true);

    const data = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i]));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  async function toWav(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try {
      const ab = await blob.arrayBuffer();
      const decoded = await new Promise((resolve, reject) => {
        const p = ctx.decodeAudioData(ab, resolve, reject); // Safari cũ chỉ hỗ trợ callback
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
      return encodeWav(decoded);
    } finally {
      try { ctx.close(); } catch (e) { /* bỏ qua */ }
    }
  }

  SGA.wav = { encodeWav, toWav };
})(window.SGA = window.SGA || {});
