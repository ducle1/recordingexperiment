/* Phân tích cao độ (F0) và độ lớn (intensity) của 1 file WAV PCM 16-bit.
 *
 * Cao độ: thuật toán YIN (de Cheveigné & Kawahara 2002) trên tín hiệu đã hạ tần số lấy mẫu,
 *         khung 40 ms, bước 10 ms, dải 60–600 Hz, ngưỡng 0,15; bỏ khung quá nhỏ tiếng,
 *         sửa nhảy quãng tám bằng trung vị trượt, bỏ đoạn hữu thanh ngắn hơn 30 ms.
 * Độ lớn: dB = 10·log10(trung bình bình phương có cửa sổ Hann 40 ms / (2·10⁻⁵)²),
 *         cùng thang với Praat (biên độ 1 = 1 Pa), bước 10 ms.
 */
'use strict';

const HOP = 0.01;
const WIN = 0.04;
const F0_MIN = 60;
const F0_MAX = 600;
const YIN_THRESHOLD = 0.15;
const SILENCE_BELOW_MAX = 30;   // dB: khung nhỏ hơn mức lớn nhất quá 30 dB coi là im lặng
const SPEECH_BELOW_MAX = 25;    // dB: xác định đầu/cuối lời nói

function parseWav(buf) {
  const v = new DataView(buf);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Không phải file WAV');
  let off = 12, rate = 0, ch = 1, bits = 16, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') {
      ch = v.getUint16(off + 10, true);
      rate = v.getUint32(off + 12, true);
      bits = v.getUint16(off + 22, true);
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = Math.min(size, buf.byteLength - dataOff);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0 || bits !== 16) throw new Error('Định dạng WAV không hỗ trợ');
  const n = Math.floor(dataLen / 2 / ch);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = v.getInt16(dataOff + i * 2 * ch, true) / 32768;
  return { rate, x };
}

/** Lọc thông thấp (sinc có cửa sổ Blackman) rồi lấy 1 mẫu mỗi `d` mẫu. */
function decimate(x, d) {
  if (d <= 1) return x;
  const taps = 16 * d + 1;
  const fc = 0.45 / d;               // tần số cắt (theo tần số lấy mẫu gốc)
  const hcoef = new Float32Array(taps);
  const m = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - m;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    hcoef[i] = sinc * w;
    sum += hcoef[i];
  }
  for (let i = 0; i < taps; i++) hcoef[i] /= sum;
  const out = new Float32Array(Math.floor(x.length / d));
  for (let o = 0; o < out.length; o++) {
    const c = o * d;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const j = c + i - m;
      if (j >= 0 && j < x.length) acc += x[j] * hcoef[i];
    }
    out[o] = acc;
  }
  return out;
}

function intensity(x, rate, nFrames) {
  const W = Math.round(WIN * rate);
  const hop = HOP * rate;
  const win = new Float32Array(W);
  let wsum = 0;
  for (let i = 0; i < W; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (W - 1)); wsum += win[i]; }
  const db = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const start = Math.round(f * hop);
    let acc = 0;
    for (let i = 0; i < W; i++) {
      const s = x[start + i] || 0;
      acc += win[i] * s * s;
    }
    const ms = acc / wsum;
    db[f] = ms > 1e-14 ? 10 * Math.log10(ms / 4e-10) : 0;
  }
  return db;
}

function yin(y, sr, nFrames, frameStartOrig, origRate) {
  const W = Math.round(WIN * sr);
  const tauMin = Math.max(2, Math.floor(sr / F0_MAX));
  const tauMax = Math.ceil(sr / F0_MIN);
  const d = new Float32Array(tauMax + 2);
  const f0 = new Float32Array(nFrames).fill(NaN);
  for (let f = 0; f < nFrames; f++) {
    const start = Math.round((frameStartOrig(f) * sr) / origRate);
    if (start + W + tauMax + 1 >= y.length) break;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let acc = 0;
      for (let j = 0; j < W; j++) {
        const diff = y[start + j] - y[start + j + tau];
        acc += diff * diff;
      }
      d[tau] = acc;
    }
    // hàm hiệu chuẩn hoá tích luỹ (CMNDF)
    let running = 0;
    let best = -1;
    let bestVal = Infinity;
    const cm = new Float32Array(tauMax + 2);
    cm[0] = 1;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += d[tau];
      cm[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cm[tau] < YIN_THRESHOLD) {
        while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
        best = tau;
        bestVal = cm[tau];
        break;
      }
    }
    if (best < 0) continue;
    // nội suy parabol quanh điểm cực tiểu
    const a = cm[best - 1], b = cm[best], c = cm[best + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
    const t = best + Math.max(-1, Math.min(1, shift));
    if (bestVal <= YIN_THRESHOLD) f0[f] = sr / t;
  }
  return f0;
}

function cleanPitch(f0, db, maxDb) {
  const n = f0.length;
  // 1) bỏ khung gần như im lặng
  for (let i = 0; i < n; i++) if (db[i] < maxDb - SILENCE_BELOW_MAX) f0[i] = NaN;
  // 2) sửa nhảy quãng tám: so với trung vị 7 khung hữu thanh xung quanh
  const out = Float32Array.from(f0);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(f0[i])) continue;
    const win = [];
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) if (!Number.isNaN(f0[k])) win.push(f0[k]);
    win.sort((p, q) => p - q);
    const med = win[Math.floor(win.length / 2)];
    const oct = Math.log2(f0[i] / med);
    if (Math.abs(oct) > 0.75) out[i] = NaN;                       // lệch quá xa → bỏ
    else if (Math.abs(oct) > 0.4) out[i] = f0[i] * Math.pow(2, -Math.round(oct)); // nhảy quãng tám → kéo về
  }
  // 3) bỏ đoạn hữu thanh ngắn hơn 3 khung (30 ms)
  let i = 0;
  while (i < n) {
    if (Number.isNaN(out[i])) { i++; continue; }
    let j = i;
    while (j < n && !Number.isNaN(out[j])) j++;
    if (j - i < 3) for (let k = i; k < j; k++) out[k] = NaN;
    i = j;
  }
  return out;
}

function stats(arr) {
  const v = Array.from(arr).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) * (x - mean), 0) / v.length);
  return { n: v.length, mean, median: v[Math.floor(v.length / 2)], min: v[0], max: v[v.length - 1], sd };
}

function analyze(buffer) {
  const { rate, x } = parseWav(buffer);
  // bỏ thành phần một chiều (DC)
  let dc = 0;
  for (let i = 0; i < x.length; i++) dc += x[i];
  dc /= x.length || 1;
  for (let i = 0; i < x.length; i++) x[i] -= dc;

  const W = Math.round(WIN * rate);
  const hop = HOP * rate;
  const nFrames = Math.max(0, Math.floor((x.length - W) / hop) + 1);
  const times = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) times[f] = (f * hop + W / 2) / rate;

  const db = intensity(x, rate, nFrames);
  let maxDb = 0;
  for (let f = 0; f < nFrames; f++) if (db[f] > maxDb) maxDb = db[f];

  const dFac = Math.max(1, Math.floor(rate / 11000));
  const y = decimate(x, dFac);
  const sr = rate / dFac;
  let f0 = yin(y, sr, nFrames, (f) => Math.round(f * hop), rate);
  f0 = cleanPitch(f0, db, maxDb);

  // đầu / cuối lời nói
  let on = -1, off = -1;
  for (let f = 0; f < nFrames; f++) if (db[f] >= maxDb - SPEECH_BELOW_MAX) { if (on < 0) on = f; off = f; }
  const speechDb = on >= 0 ? db.slice(on, off + 1) : new Float32Array(0);
  const p = stats(f0);
  const it = stats(speechDb);
  const summary = {
    duration: x.length / rate,
    sample_rate: rate,
    speech_onset: on >= 0 ? times[on] : null,
    speech_offset: off >= 0 ? times[off] : null,
    voiced_pct: nFrames ? (100 * (p ? p.n : 0)) / Math.max(1, off - on + 1) : 0,
    f0_mean: p ? p.mean : null,
    f0_median: p ? p.median : null,
    f0_min: p ? p.min : null,
    f0_max: p ? p.max : null,
    f0_sd: p ? p.sd : null,
    f0_range_st: p ? 12 * Math.log2(p.max / p.min) : null,
    int_mean: it ? it.mean : null,
    int_max: it ? it.max : null,
  };
  return { times, f0, db, summary };
}

self.onmessage = (e) => {
  const { id, buffer } = e.data;
  try {
    const r = analyze(buffer);
    self.postMessage({ id, ok: true, result: r }, [r.times.buffer, r.f0.buffer, r.db.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
