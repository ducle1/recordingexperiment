/* Recording Admin — nghe bản ghi, phân tích cao độ / độ lớn, xuất dữ liệu, ảnh minh hoạ */
(() => {
  'use strict';

  const CSRF = (document.querySelector('meta[name="csrf"]') || {}).content || '';
  const ALGO = 'yin1';   // đổi khi đổi thuật toán → bỏ kết quả cũ trong bộ nhớ đệm
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d).replace('.', ','));

  /* ------------------------------------------------------- tiện ích chung */

  $$('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, label')) return;
    location.href = tr.dataset.href;
  }));
  $$('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => {
    if (!confirm(f.dataset.confirm)) e.preventDefault();
  }));
  $$('form[data-clear-local]').forEach((f) => f.addEventListener('submit', () => {
    try { localStorage.removeItem('rec_pid'); localStorage.removeItem('rec_done'); } catch (_) { /* bỏ qua */ }
  }));

  const Job = {
    el: $('#job'),
    show(text, frac) {
      if (!this.el) return;
      this.el.hidden = false;
      this.el.className = 'job';
      $('#job-text').textContent = text;
      $('#job-bar').style.width = frac === undefined ? '0' : Math.round(frac * 100) + '%';
    },
    done(text) { this.show(text, 1); this.el.classList.add('done'); setTimeout(() => { this.el.hidden = true; }, 4000); },
    err(text) { this.show(text, 0); this.el.classList.add('err'); },
  };

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
  }

  async function mapLimit(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k], k); }
    }));
  }

  /* ---------------------------------------------- bộ nhớ đệm kết quả phân tích */

  const Cache = {
    dbp: null,
    open() {
      if (!this.dbp) {
        this.dbp = new Promise((resolve) => {
          try {
            const req = indexedDB.open('rec-admin', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('analysis');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
          } catch (_) { resolve(null); }
        });
      }
      return this.dbp;
    },
    async get(key) {
      const db = await this.open();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const r = db.transaction('analysis').objectStore('analysis').get(key);
          r.onsuccess = () => resolve(r.result || null);
          r.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
      });
    },
    async put(key, val) {
      const db = await this.open();
      if (!db) return;
      try { db.transaction('analysis', 'readwrite').objectStore('analysis').put(val, key); } catch (_) { /* bỏ qua */ }
    },
  };

  /* --------------------------------------------------------- phân tích */

  const Analyzer = {
    workers: [], idle: [], waiting: [], seq: 0, pending: new Map(),
    init() {
      if (this.workers.length) return;
      const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
      for (let i = 0; i < n; i++) {
        const w = new Worker('/assets/analysis-worker.js');
        w.onmessage = (e) => {
          const p = this.pending.get(e.data.id);
          this.pending.delete(e.data.id);
          this.idle.push(w);
          this.pump();
          if (p) (e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error)));
        };
        this.workers.push(w);
        this.idle.push(w);
      }
    },
    analyze(buffer) {
      this.init();
      return new Promise((resolve, reject) => {
        this.waiting.push({ buffer, resolve, reject });
        this.pump();
      });
    },
    pump() {
      while (this.idle.length && this.waiting.length) {
        const w = this.idle.pop();
        const job = this.waiting.shift();
        const id = ++this.seq;
        this.pending.set(id, job);
        w.postMessage({ id, buffer: job.buffer }, [job.buffer]);
      }
    },
  };

  const audioCache = new Map();
  function fetchAudio(path) {
    if (!audioCache.has(path)) {
      const p = fetch('/admin?action=audio&path=' + encodeURIComponent(path), { credentials: 'same-origin' })
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
      p.catch(() => audioCache.delete(path));
      audioCache.set(path, p);
    }
    return audioCache.get(path);
  }

  async function getAnalysis(path, size, t) {
    const key = [ALGO, path, size, t || ''].join('|');
    const hit = await Cache.get(key);
    if (hit) return hit;
    const buf = await fetchAudio(path);
    const r = await Analyzer.analyze(buf.slice(0));
    Cache.put(key, r);
    return r;
  }

  function rangeStats(a, t0, t1) {
    const f = [], d = [];
    for (let i = 0; i < a.times.length; i++) {
      const t = a.times[i];
      if (t < t0 || t > t1) continue;
      if (!Number.isNaN(a.f0[i])) f.push(a.f0[i]);
      d.push(a.db[i]);
    }
    const mean = (v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
    return {
      f0_mean: mean(f), f0_min: f.length ? Math.min(...f) : null, f0_max: f.length ? Math.max(...f) : null,
      db_mean: mean(d), db_max: d.length ? Math.max(...d) : null,
    };
  }

  function niceStep(span, target) {
    const raw = span / target;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  /* ------------------------------------------------- 1 bản ghi (biểu đồ + nghe) */

  let playing = null;   // RecView đang phát

  class RecView {
    constructor(el) {
      this.el = el;
      this.path = el.dataset.path;
      this.size = Number(el.dataset.size);
      this.t = el.dataset.t;
      this.canvas = $('canvas', el);
      this.msg = $('.chart-msg', el);
      this.nums = $('.nums', el);
      this.btn = $('.play', el);
      this.a = null;          // kết quả phân tích
      this.audio = null;
      this.sel = null;        // { t0, t1 }
      this.stopAt = null;
      this.raf = 0;
      this.btn.addEventListener('click', () => this.toggle());
      this.bindPointer();
      new ResizeObserver(() => this.draw()).observe(this.canvas);
    }

    async load() {
      try {
        this.a = await getAnalysis(this.path, this.size, this.t);
        this.msg.hidden = true;
        this.draw();
        this.renderNums();
      } catch (e) {
        this.msg.textContent = 'Không phân tích được: ' + e.message;
      }
      return this.a;
    }

    get duration() { return this.a ? this.a.summary.duration : 0; }

    async ensureAudio() {
      if (this.audio) return this.audio;
      const buf = await fetchAudio(this.path);
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      const au = new Audio(url);
      au.preload = 'auto';
      au.addEventListener('play', () => { this.btn.classList.add('on'); this.loop(); });
      au.addEventListener('pause', () => { this.btn.classList.remove('on'); cancelAnimationFrame(this.raf); this.draw(); });
      au.addEventListener('ended', () => { this.btn.classList.remove('on'); this.stopAt = null; });
      this.audio = au;
      return au;
    }

    async play(from = null, to = null) {
      const au = await this.ensureAudio();
      if (playing && playing !== this && playing.audio) playing.audio.pause();
      playing = this;
      if (from !== null) au.currentTime = Math.max(0, from);
      else if (au.ended) au.currentTime = 0;
      this.stopAt = to;
      au.play().catch(() => {});
    }

    toggle() {
      if (this.audio && !this.audio.paused) return this.audio.pause();
      if (this.sel) return this.play(this.sel.t0, this.sel.t1);
      return this.play(this.audio && !this.audio.ended ? null : 0);
    }

    loop() {
      cancelAnimationFrame(this.raf);
      const step = () => {
        if (!this.audio || this.audio.paused) return;
        if (this.stopAt !== null && this.audio.currentTime >= this.stopAt) {
          this.audio.pause();
          this.stopAt = null;
          return;
        }
        this.draw();
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }

    geom() {
      const r = this.canvas.getBoundingClientRect();
      return { w: r.width, h: r.height, l: 40, rt: 34, t: 16, b: 20 };
    }

    timeAt(clientX) {
      const r = this.canvas.getBoundingClientRect();
      const g = this.geom();
      const x = clientX - r.left;
      return Math.max(0, Math.min(this.duration, ((x - g.l) / (g.w - g.l - g.rt)) * this.duration));
    }

    bindPointer() {
      let down = null;
      this.canvas.addEventListener('pointerdown', (e) => {
        if (!this.a) return;
        down = { x: e.clientX, t: this.timeAt(e.clientX), drag: false };
        this.canvas.setPointerCapture(e.pointerId);
      });
      this.canvas.addEventListener('pointermove', (e) => {
        if (!down) return;
        if (!down.drag && Math.abs(e.clientX - down.x) > 4) down.drag = true;
        if (down.drag) {
          const t = this.timeAt(e.clientX);
          this.sel = { t0: Math.min(down.t, t), t1: Math.max(down.t, t) };
          this.draw();
        }
      });
      const up = () => {
        if (!down) return;
        if (down.drag && this.sel && this.sel.t1 - this.sel.t0 > 0.03) {
          this.renderNums();
          this.play(this.sel.t0, this.sel.t1);
        } else {
          this.sel = null;
          this.renderNums();
          this.play(down.t);
        }
        down = null;
        this.draw();
      };
      this.canvas.addEventListener('pointerup', up);
      this.canvas.addEventListener('pointercancel', () => { down = null; });
    }

    draw() {
      const cv = this.canvas;
      const g = this.geom();
      if (!g.w) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(g.w * dpr) || cv.height !== Math.round(g.h * dpr)) {
        cv.width = Math.round(g.w * dpr);
        cv.height = Math.round(g.h * dpr);
      }
      const c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, g.w, g.h);
      if (!this.a) return;
      const { times, f0, db, summary } = this.a;
      const pw = g.w - g.l - g.rt;
      const ph = g.h - g.t - g.b;
      const dur = summary.duration || 1;
      const X = (t) => g.l + (t / dur) * pw;
      const muted = css('--muted');
      const line = css('--line');
      c.font = '10.5px -apple-system, Segoe UI, Roboto, sans-serif';

      // thang độ lớn (phải)
      let dbMax = 0;
      for (let i = 0; i < db.length; i++) if (db[i] > dbMax) dbMax = db[i];
      const dbTop = Math.ceil((dbMax + 3) / 10) * 10;
      const dbBot = dbTop - 60;
      const Yd = (v) => g.t + ph * (1 - (Math.max(dbBot, Math.min(dbTop, v)) - dbBot) / (dbTop - dbBot));

      // thang cao độ (trái)
      const s = this.scale || (() => {
        const lo = summary.f0_min || 75;
        const hi = summary.f0_max || 300;
        const pad = Math.max(15, (hi - lo) * 0.15);
        return { lo: Math.max(40, lo - pad), hi: Math.min(700, hi + pad) };
      })();
      const Yf = (v) => g.t + ph * (1 - (v - s.lo) / (s.hi - s.lo));

      // lưới + nhãn Hz
      c.strokeStyle = line;
      c.lineWidth = 1;
      c.fillStyle = muted;
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      const fs = niceStep(s.hi - s.lo, 4);
      for (let v = Math.ceil(s.lo / fs) * fs; v <= s.hi; v += fs) {
        const y = Math.round(Yf(v)) + 0.5;
        c.beginPath(); c.moveTo(g.l, y); c.lineTo(g.l + pw, y); c.stroke();
        c.fillText(String(v), g.l - 6, y);
      }
      c.fillText('Hz', g.l - 6, 7);
      // nhãn dB
      c.textAlign = 'left';
      for (let v = dbBot + 20; v <= dbTop; v += 20) c.fillText(String(v), g.l + pw + 6, Yd(v));
      c.fillText('dB', g.l + pw + 6, 7);
      // trục thời gian
      c.textAlign = 'center';
      c.textBaseline = 'top';
      const ts = niceStep(dur, 6);
      for (let t = 0; t <= dur + 1e-6; t += ts) {
        const x = X(t);
        c.fillText(t < 1e-9 ? '0' : t.toFixed(ts < 1 ? 1 : 0).replace('.', ',') + ' s', x, g.t + ph + 5);
      }

      // vùng chọn
      if (this.sel) {
        c.fillStyle = css('--sel');
        c.fillRect(X(this.sel.t0), g.t, X(this.sel.t1) - X(this.sel.t0), ph);
      }

      // độ lớn: vùng tô + đường
      c.beginPath();
      c.moveTo(X(times[0] || 0), g.t + ph);
      for (let i = 0; i < times.length; i++) c.lineTo(X(times[i]), Yd(db[i]));
      c.lineTo(X(times[times.length - 1] || 0), g.t + ph);
      c.closePath();
      c.fillStyle = css('--db-fill');
      c.fill();
      c.beginPath();
      for (let i = 0; i < times.length; i++) (i ? c.lineTo(X(times[i]), Yd(db[i])) : c.moveTo(X(times[i]), Yd(db[i])));
      c.strokeStyle = css('--db');
      c.lineWidth = 1.2;
      c.stroke();

      // cao độ: chấm
      c.fillStyle = css('--f0');
      for (let i = 0; i < times.length; i++) {
        const v = f0[i];
        if (Number.isNaN(v) || v < s.lo || v > s.hi) continue;
        c.beginPath();
        c.arc(X(times[i]), Yf(v), 1.9, 0, Math.PI * 2);
        c.fill();
      }

      // đầu phát
      if (this.audio && (this.audio.currentTime > 0 || !this.audio.paused)) {
        const x = Math.round(X(this.audio.currentTime)) + 0.5;
        c.strokeStyle = css('--accent');
        c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(x, g.t); c.lineTo(x, g.t + ph); c.stroke();
      }
    }

    renderNums() {
      if (!this.a) return;
      const m = this.a.summary;
      const rows = [
        ['Lời nói', m.speech_onset !== null ? `${fmt(m.speech_onset, 2)}–${fmt(m.speech_offset, 2)} s` : '—'],
        ['F0 trung bình', fmt(m.f0_mean) + ' Hz'],
        ['F0 thấp – cao', `${fmt(m.f0_min)} – ${fmt(m.f0_max)} Hz`],
        ['Biên độ cao độ', fmt(m.f0_range_st, 1) + ' st'],
        ['Độ lớn TB / max', `${fmt(m.int_mean, 1)} / ${fmt(m.int_max, 1)} dB`],
      ];
      let html = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
      if (this.sel) {
        const r = rangeStats(this.a, this.sel.t0, this.sel.t1);
        html += `<div class="sel"><b>Đoạn ${fmt(this.sel.t0, 2)}–${fmt(this.sel.t1, 2)} s</b> (${fmt((this.sel.t1 - this.sel.t0) * 1000)} ms)<br>
          F0 TB ${fmt(r.f0_mean)} Hz · max ${fmt(r.f0_max)} Hz<br>Độ lớn TB ${fmt(r.db_mean, 1)} dB · max ${fmt(r.db_max, 1)} dB
          <button type="button" data-clear>Bỏ chọn</button></div>`;
      }
      this.nums.innerHTML = html;
      const clr = $('[data-clear]', this.nums);
      if (clr) clr.addEventListener('click', () => { this.sel = null; this.renderNums(); this.draw(); });
    }
  }

  const views = $$('.rec[data-path]').map((el) => new RecView(el));
  const loaded = new Promise((resolve) => {
    const out = [];
    mapLimit(views, 3, async (v, i) => { out[i] = await v.load(); }).then(() => resolve(out));
  });

  /* ------------------------------------------- trang theo câu: chồng đường cao độ */

  const overlay = $('#overlay');
  if (overlay) {
    let mode = 'st';
    const head = $('.overlay-head');
    const seg = document.createElement('span');
    seg.className = 'seg';
    seg.innerHTML = '<button type="button" data-m="st" class="on">Semitone (so với trung vị từng người)</button><button type="button" data-m="hz">Hz</button>';
    head.appendChild(seg);
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      mode = b.dataset.m;
      $$('button', seg).forEach((x) => x.classList.toggle('on', x === b));
      drawOverlay();
    });
    let results = [];
    const BINS = 60;
    function contours() {
      return results.filter(Boolean).map((a) => {
        const m = a.summary;
        if (m.speech_onset === null || !m.f0_median) return null;
        const span = Math.max(0.05, m.speech_offset - m.speech_onset);
        const pts = [];
        for (let i = 0; i < a.times.length; i++) {
          const v = a.f0[i];
          if (Number.isNaN(v)) { pts.push(null); continue; }
          const x = (a.times[i] - m.speech_onset) / span;
          if (x < 0 || x > 1) continue;
          pts.push([x, mode === 'st' ? 12 * Math.log2(v / m.f0_median) : v]);
        }
        return pts;
      }).filter(Boolean);
    }
    function drawOverlay() {
      const cs = contours();
      const r = overlay.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      overlay.width = Math.round(r.width * dpr);
      overlay.height = Math.round(r.height * dpr);
      const c = overlay.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, r.width, r.height);
      const g = { l: 44, r: 24, t: 10, b: 24 };
      const pw = r.width - g.l - g.r;
      const ph = r.height - g.t - g.b;
      let lo = Infinity, hi = -Infinity;
      cs.forEach((p) => p.forEach((q) => { if (q) { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); } }));
      if (!Number.isFinite(lo)) { lo = mode === 'st' ? -6 : 80; hi = mode === 'st' ? 6 : 300; }
      const pad = (hi - lo) * 0.08 || 1;
      lo -= pad; hi += pad;
      const X = (x) => g.l + x * pw;
      const Y = (v) => g.t + ph * (1 - (v - lo) / (hi - lo));
      c.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
      c.strokeStyle = css('--line');
      c.fillStyle = css('--muted');
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      const st = niceStep(hi - lo, 5);
      for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) {
        const y = Math.round(Y(v)) + 0.5;
        c.beginPath(); c.moveTo(g.l, y); c.lineTo(g.l + pw, y); c.stroke();
        c.fillText((Math.abs(v) < 1e-9 ? 0 : +v.toFixed(1)) + '', g.l - 6, y);
      }
      c.save();
      c.translate(12, g.t + ph / 2);
      c.rotate(-Math.PI / 2);
      c.textAlign = 'center';
      c.fillText(mode === 'st' ? 'semitone' : 'Hz', 0, 0);
      c.restore();
      c.textAlign = 'center';
      c.textBaseline = 'top';
      for (let k = 0; k <= 4; k++) c.fillText(k * 25 + '%', X(k / 4), g.t + ph + 6);
      // từng người
      const f0c = css('--f0');
      c.lineWidth = 1.2;
      c.strokeStyle = f0c;
      c.globalAlpha = cs.length > 12 ? 0.22 : 0.38;
      cs.forEach((pts) => {
        c.beginPath();
        let pen = false;
        pts.forEach((q) => {
          if (!q) { pen = false; return; }
          if (pen) c.lineTo(X(q[0]), Y(q[1])); else { c.moveTo(X(q[0]), Y(q[1])); pen = true; }
        });
        c.stroke();
      });
      c.globalAlpha = 1;
      // trung bình theo từng khoảng
      const sums = new Array(BINS).fill(0);
      const ns = new Array(BINS).fill(0);
      cs.forEach((pts) => {
        const own = new Array(BINS).fill(null).map(() => []);
        pts.forEach((q) => { if (q) own[Math.min(BINS - 1, Math.floor(q[0] * BINS))].push(q[1]); });
        own.forEach((v, i) => { if (v.length) { sums[i] += v.reduce((s, x) => s + x, 0) / v.length; ns[i]++; } });
      });
      const minN = Math.max(2, Math.ceil(cs.length / 3));
      c.strokeStyle = css('--text');
      c.lineWidth = 2.6;
      c.beginPath();
      let pen = false;
      for (let i = 0; i < BINS; i++) {
        if (ns[i] < minN) { pen = false; continue; }
        const x = X((i + 0.5) / BINS);
        const y = Y(sums[i] / ns[i]);
        if (pen) c.lineTo(x, y); else { c.moveTo(x, y); pen = true; }
      }
      c.stroke();
    }
    loaded.then((r) => { results = r; drawOverlay(); });
    new ResizeObserver(() => { if (results.length) drawOverlay(); }).observe(overlay);
  }

  /* ---------------------------------------------------------- xuất dữ liệu */

  async function loadData() {
    const r = await fetch('/admin?action=data', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  const csvCell = (v) => {
    if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const num = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? '' : Number(v).toFixed(d));
  const fileNameOf = (p, r) => `${p.code}_${String(r.position).padStart(2, '0')}_${r.item_id}.wav`;
  const today = () => new Date().toISOString().slice(0, 10);

  async function exportAnalysis() {
    try {
      Job.show('Đang lấy danh sách bản ghi…');
      const data = await loadData();
      const list = [];
      data.participants.forEach((p) => p.recordings.forEach((r) => list.push({ p, r })));
      if (!list.length) return Job.done('Chưa có bản ghi nào.');
      const out = new Array(list.length);
      let n = 0;
      await mapLimit(list, 3, async ({ p, r }, i) => {
        out[i] = await getAnalysis(r.path, r.size, new Date(r.uploaded_at).getTime()).catch(() => null);
        Job.show(`Đang phân tích ${++n}/${list.length} bản ghi (lần sau sẽ nhanh hơn nhờ bộ nhớ đệm)…`, n / list.length);
      });
      const rows = [['code', 'excluded', 'status', 'device', 'age', 'country', 'position', 'item_id', 'group', 'group_label', 'sentence', 'restarts',
        'duration_s', 'speech_onset_s', 'speech_offset_s', 'speech_dur_s', 'f0_mean_hz', 'f0_median_hz', 'f0_min_hz', 'f0_max_hz', 'f0_sd_hz',
        'f0_range_st', 'intensity_mean_db', 'intensity_max_db', 'sample_rate', 'file', 'uploaded_at']];
      list.forEach(({ p, r }, i) => {
        const m = out[i] ? out[i].summary : {};
        const d = p.demographics || {};
        rows.push([p.code, p.excluded ? 1 : 0, p.status, p.device, d.age, d.country, r.position, r.item_id, r.group, r.group_label, r.sentence, r.restarts,
          num(m.duration, 3), num(m.speech_onset, 3), num(m.speech_offset, 3),
          m.speech_onset !== null && m.speech_onset !== undefined ? num(m.speech_offset - m.speech_onset, 3) : '',
          num(m.f0_mean, 1), num(m.f0_median, 1), num(m.f0_min, 1), num(m.f0_max, 1), num(m.f0_sd, 1), num(m.f0_range_st, 2),
          num(m.int_mean, 1), num(m.int_max, 1), m.sample_rate || '', fileNameOf(p, r), r.uploaded_at]);
      });
      download(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), `analysis-${today()}.csv`);
      Job.done(`Đã xuất ${list.length} bản ghi.`);
    } catch (e) {
      Job.err('Xuất thất bại: ' + e.message);
    }
    return undefined;
  }

  /* ZIP không nén (WAV gần như không nén được), đủ cho Windows/macOS mở trực tiếp */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, x) => s + x.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  async function zipRecordings(code) {
    try {
      Job.show('Đang lấy danh sách bản ghi…');
      const data = await loadData();
      const ps = data.participants.filter((p) => !code || p.code === code);
      const list = [];
      ps.forEach((p) => p.recordings.forEach((r) => list.push({ p, r })));
      if (!list.length) return Job.done('Chưa có bản ghi nào.');
      const bytes = list.reduce((s, x) => s + x.r.size, 0);
      if (bytes > 1.5e9 && !confirm(`Tổng ${(bytes / 1e9).toFixed(1)} GB, có thể quá nặng cho trình duyệt. Vẫn tiếp tục?`)) { Job.el.hidden = true; return undefined; }
      const files = [];
      let n = 0;
      await mapLimit(list, 4, async ({ p, r }, i) => {
        const buf = await fetchAudio(r.path);
        files[i] = { name: (code ? '' : p.code + '/') + fileNameOf(p, r), data: new Uint8Array(buf) };
        Job.show(`Đang tải ${++n}/${list.length} bản ghi…`, n / list.length);
      });
      const meta = [['code', 'excluded', 'status', 'position', 'item_id', 'group', 'sentence', 'restarts', 'file', 'uploaded_at']];
      list.forEach(({ p, r }) => meta.push([p.code, p.excluded ? 1 : 0, p.status, r.position, r.item_id, r.group, r.sentence, r.restarts,
        (code ? '' : p.code + '/') + fileNameOf(p, r), r.uploaded_at]));
      files.push({ name: 'recordings.csv', data: new TextEncoder().encode(toCsv(meta)) });
      download(makeZip(files), `${code || 'all'}-recordings-${today()}.zip`);
      Job.done(`Đã nén ${list.length} bản ghi.`);
    } catch (e) {
      Job.err('Tải thất bại: ' + e.message);
    }
    return undefined;
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.action === 'export-analysis') exportAnalysis();
    if (a.dataset.action === 'zip-all') zipRecordings(null);
    if (a.dataset.action === 'zip-one') zipRecordings(a.dataset.code);
  });

  /* ---------------------------------------------------------- ảnh minh hoạ */

  async function shrinkImage(file) {
    const MAX = 1600;
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (_) { return file; }
    const big = Math.max(bmp.width, bmp.height);
    if (big <= MAX && file.size <= 1.5e6) return file;
    const k = Math.min(1, MAX / big);
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k);
    cv.height = Math.round(bmp.height * k);
    const c = cv.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, cv.width, cv.height);
    c.drawImage(bmp, 0, 0, cv.width, cv.height);
    return new Promise((resolve) => cv.toBlob((b) => resolve(b || file), 'image/jpeg', 0.86));
  }

  async function postImage(action, item, body) {
    const r = await fetch(`/admin?action=${action}&item=${encodeURIComponent(item)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-REC': '1', 'X-CSRF': CSRF, 'Content-Type': body ? body.type : 'application/octet-stream' },
      body: body || '',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }

  $$('input[data-upload]').forEach((inp) => inp.addEventListener('change', async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    try {
      Job.show('Đang tải ảnh lên…', 0.3);
      await postImage('image', inp.dataset.upload, await shrinkImage(file));
      Job.done('Đã lưu ảnh.');
      location.reload();
    } catch (e) {
      Job.err('Không tải được ảnh: ' + e.message);
    }
  }));
  $$('[data-img-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Xoá ảnh minh hoạ của câu này?')) return;
    try {
      await postImage('image_delete', b.dataset.imgDelete, null);
      location.reload();
    } catch (e) {
      Job.err('Không xoá được ảnh: ' + e.message);
    }
  }));
})();
