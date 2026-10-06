/* Speaking Study — participant client */
(() => {
  'use strict';

  const API = '/api/participant';
  const LS_TOKEN = 'rec_pid';
  const LS_DONE = 'rec_done';
  const PREROLL_S = 0.25;      // giữ 0.25 s trước khi bấm Record để không mất âm đầu
  const TAIL_MS = 350;         // ghi thêm 0.35 s sau khi bấm Stop để không mất âm cuối
  const MIN_TAKE_MS = 700;     // ngắn hơn → hỏi lại
  const QUIET_DB = -40;        // đỉnh thấp hơn → hỏi lại (gần như im lặng)
  const SAVED_PAUSE_MS = 650;  // hiện "Saved" trước khi sang câu mới

  // Mã người tham gia từ nền tảng tuyển (vd. Prolific) nếu có trong link
  const EXT_ID = (() => {
    const sp = new URLSearchParams(location.search);
    for (const k of ['PROLIFIC_PID', 'workerId', 'participant', 'pid']) if (sp.get(k)) return sp.get(k);
    return '';
  })();

  const US_STATES = ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','District of Columbia','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming','Puerto Rico','Guam','U.S. Virgin Islands','American Samoa','Northern Mariana Islands'];

  const COUNTRIES = ['Afghanistan','Albania','Algeria','Andorra','Angola','Antigua and Barbuda','Argentina','Armenia','Australia','Austria','Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan','Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cabo Verde','Cambodia','Cameroon','Canada','Central African Republic','Chad','Chile','China','Colombia','Comoros','Congo','Costa Rica',"Côte d'Ivoire",'Croatia','Cuba','Cyprus','Czechia','Democratic Republic of the Congo','Denmark','Djibouti','Dominica','Dominican Republic','Ecuador','Egypt','El Salvador','Equatorial Guinea','Eritrea','Estonia','Eswatini','Ethiopia','Fiji','Finland','France','Gabon','Gambia','Georgia','Germany','Ghana','Greece','Grenada','Guatemala','Guinea','Guinea-Bissau','Guyana','Haiti','Honduras','Hong Kong','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kiribati','Kosovo','Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg','Macau','Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Marshall Islands','Mauritania','Mauritius','Mexico','Micronesia','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nauru','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia','Norway','Oman','Pakistan','Palau','Palestine','Panama','Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal','Qatar','Romania','Russia','Rwanda','Saint Kitts and Nevis','Saint Lucia','Saint Vincent and the Grenadines','Samoa','San Marino','Sao Tome and Principe','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia','Slovenia','Solomon Islands','Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan','Suriname','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Timor-Leste','Togo','Tonga','Trinidad and Tobago','Tunisia','Turkey','Turkmenistan','Tuvalu','Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan','Vanuatu','Vatican City','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe'];

  const $ = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* bỏ qua */ } };

  const TOUCH = (() => {
    const fine = window.matchMedia && window.matchMedia('(any-pointer: fine)').matches;
    const touch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    return touch && !fine;
  })();
  document.body.classList.toggle('keyboard', !TOUCH);

  let S = null;          // trạng thái từ server
  let queue = [];        // các câu chưa lưu, theo thứ tự
  let cur = null;        // câu đang làm: { trial, restarts, take, wav }
  let dock = 'off';      // off | ready | recording | review | saving | saved
  let timerId = 0;
  let errorMode = '';    // 'upload' = lưu bản ghi thất bại, 'fatal' = phải tải lại trang
  let autoStopId = 0;

  /* ------------------------------------------------------------ helpers */

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    window.scrollTo(0, 0);
  }

  async function api(action, { body, raw, query } = {}) {
    let url = API + '?action=' + encodeURIComponent(action);
    if (query) url += '&' + new URLSearchParams(query).toString();
    const headers = { 'X-REC': '1' };
    const tok = lsGet(LS_TOKEN);
    if (tok) headers['X-Rec-Pid'] = tok;
    const opts = { credentials: 'same-origin', headers, cache: 'no-store' };
    if (raw) {
      opts.method = 'POST';
      headers['Content-Type'] = 'application/octet-stream';
      opts.body = raw;
    } else if (body !== undefined) {
      opts.method = 'POST';
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else {
      url += '&t=' + Date.now();
    }
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch (_) { /* rỗng */ }
    if (data && data.token) lsSet(LS_TOKEN, data.token);
    return { status: res.status, data: data || {} };
  }

  async function apiRetry(action, opts, tries = 4) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      try {
        last = await api(action, opts);
        if (last.status < 500) return last;
      } catch (_) { last = null; }
      await sleep(600 * (i + 1));
    }
    return last || { status: 0, data: {} };
  }

  // Các vị trí vừa lưu thành công trên máy này (phòng khi danh sách trên server cập nhật chậm).
  // Gắn với "epoch" của hồ sơ: admin xoá bản ghi → epoch đổi → bỏ ghi nhớ cũ. Chỉ tin trong 15 phút.
  const LOCAL_TTL = 15 * 60 * 1000;
  const doneKey = () => S.code + '|' + (S.epoch || '');
  function readDone() {
    try { return JSON.parse(lsGet(LS_DONE) || '{}') || {}; } catch (_) { return {}; }
  }
  function localDone() {
    const own = readDone()[doneKey()] || {};
    const now = Date.now();
    return new Set(Object.keys(own).filter((k) => now - own[k] < LOCAL_TTL).map(Number));
  }
  function markLocalDone(pos) {
    const all = readDone();
    const now = Date.now();
    for (const k of Object.keys(all)) {         // dọn mục cũ
      const keep = Object.keys(all[k] || {}).filter((p) => now - all[k][p] < LOCAL_TTL);
      if (!keep.length) delete all[k];
    }
    const own = all[doneKey()] || {};
    own[pos] = now;
    all[doneKey()] = own;
    lsSet(LS_DONE, JSON.stringify(all));
  }

  function fatal(msg) {
    hideDock();
    errorMode = 'fatal';
    $('#err-msg').textContent = msg;
    $('#btn-retry').textContent = 'Reload';
    document.querySelector('#s-error .muted').hidden = true;
    show('s-error');
  }

  function updateProgress() {
    if (!S || !S.total) return;
    $('#progress').hidden = false;
    $('#progress-bar').style.width = (100 * S.done / S.total).toFixed(1) + '%';
  }

  /* ------------------------------------------------- môi trường trình duyệt */

  function envProblem() {
    const ua = navigator.userAgent || '';
    if (/FBAN|FBAV|FB_IAB|Instagram|Zalo|Line\/|MicroMessenger|TikTok|musical_ly/i.test(ua)) {
      return 'You opened this link inside another app, which usually blocks the microphone. Please open it in Safari or Chrome instead (use the ⋯ menu → “Open in browser”).';
    }
    if (window.isSecureContext === false) return 'This page must be opened over https:// to use the microphone.';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
      return 'This browser cannot record audio. Please use a recent version of Chrome, Safari, Edge or Firefox.';
    }
    return '';
  }

  function micErrorText(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') {
      return TOUCH
        ? 'Microphone access is blocked. Allow the microphone for this site in your browser settings (tap the “aA” or lock icon next to the address), then press the button again.'
        : 'Microphone access is blocked. Click the lock icon next to the address bar, allow the microphone, then press the button again.';
    }
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'No microphone was found. Please connect a microphone or headset and try again.';
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'The microphone is being used by another app (for example a call). Close that app and try again.';
    return 'The microphone could not be started' + (e && e.message ? ': ' + e.message : '.');
  }

  /* ------------------------------------------------------------ recorder */

  const Rec = {
    ctx: null, stream: null, src: null, node: null, sink: null,
    rate: 0, recording: false, chunks: [], count: 0, peak: 0, ring: [], ringLen: 0, t0: 0,
    onLevel: null, onEnded: null,

    alive() {
      return !!(this.ctx && this.ctx.state !== 'closed' && this.stream
        && this.stream.getAudioTracks().some((t) => t.readyState === 'live'));
    },

    async init() {
      if (this.alive()) {
        if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
        return;
      }
      this.close();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();   // tạo ngay trong cú bấm để iOS cho chạy
      let stream;
      // Tắt lọc ồn / khử vọng / tự cân âm lượng: giữ nguyên cao độ và độ lớn thật để phân tích
      const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: raw });
      } catch (e) {
        if (e && (e.name === 'OverconstrainedError' || e.name === 'TypeError')) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((e2) => { ctx.close(); throw e2; });
        } else {
          ctx.close();
          throw e;
        }
      }
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      this.ctx = ctx;
      this.stream = stream;
      this.rate = ctx.sampleRate;
      this.src = ctx.createMediaStreamSource(stream);
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;               // không phát ra loa
      this.sink.connect(ctx.destination);
      let node = null;
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        try {
          await ctx.audioWorklet.addModule('/assets/recorder-worklet.js');
          node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          node.port.onmessage = (e) => this.feed(e.data);
        } catch (_) { node = null; }
      }
      if (!node) {
        node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = (e) => this.feed(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
      this.src.connect(node);
      node.connect(this.sink);
      this.node = node;
      stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => { if (this.onEnded) this.onEnded(); }));
    },

    feed(buf) {
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = buf[i] < 0 ? -buf[i] : buf[i];
        if (a > peak) peak = a;
      }
      if (this.onLevel) this.onLevel(peak > 1e-6 ? 20 * Math.log10(peak) : -120);
      if (this.recording) {
        this.chunks.push(buf);
        this.count += buf.length;
        if (peak > this.peak) this.peak = peak;
      } else {
        this.ring.push(buf);
        this.ringLen += buf.length;
        const keep = PREROLL_S * this.rate;
        while (this.ring.length && this.ringLen - this.ring[0].length >= keep) this.ringLen -= this.ring.shift().length;
      }
    },

    start() {
      this.chunks = this.ring.slice();
      this.count = this.ringLen;
      this.ring = [];
      this.ringLen = 0;
      this.peak = 0;
      this.recording = true;
      this.t0 = performance.now();
    },

    discard() {
      this.recording = false;
      this.chunks = [];
      this.count = 0;
    },

    async stop() {
      await sleep(TAIL_MS);
      this.recording = false;
      const out = new Float32Array(this.count);
      let o = 0;
      for (const c of this.chunks) { out.set(c, o); o += c.length; }
      this.chunks = [];
      this.count = 0;
      return { samples: out, rate: this.rate, peakDb: this.peak > 1e-6 ? 20 * Math.log10(this.peak) : -120, ms: (out.length / this.rate) * 1000 };
    },

    close() {
      this.recording = false;
      if (this.stream) this.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* bỏ qua */ } });
      if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
      this.ctx = this.stream = this.src = this.node = this.sink = null;
      this.chunks = [];
      this.ring = [];
      this.ringLen = 0;
    },
  };

  /** Đổi tần số lấy mẫu (nếu cần) rồi đóng gói WAV PCM 16-bit mono. */
  async function toWav(take, target) {
    let data = take.samples;
    let rate = take.rate;
    if (target && target !== rate && data.length) {
      try {
        const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const len = Math.max(1, Math.ceil((data.length * target) / rate));
        const off = new OAC(1, len, target);
        const buf = off.createBuffer(1, data.length, rate);
        buf.getChannelData(0).set(data);
        const src = off.createBufferSource();
        src.buffer = buf;
        src.connect(off.destination);
        src.start(0);
        const rendered = await new Promise((resolve, reject) => {
          off.oncomplete = (e) => resolve(e.renderedBuffer);
          const p = off.startRendering();
          if (p && p.then) p.then(resolve, reject);
        });
        data = rendered.getChannelData(0);
        rate = target;
      } catch (_) {
        // Dự phòng: nội suy tuyến tính, để mọi file có cùng tần số lấy mẫu
        const ratio = rate / target;
        const len = Math.floor(data.length / ratio);
        const out = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          const x = i * ratio;
          const j = Math.floor(x);
          const f = x - j;
          out[i] = data[j] * (1 - f) + (data[j + 1] !== undefined ? data[j + 1] : data[j]) * f;
        }
        data = out;
        rate = target;
      }
    }
    const bytes = data.length * 2;
    const view = new DataView(new ArrayBuffer(44 + bytes));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); w(8, 'WAVE');
    w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    w(36, 'data'); view.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < data.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  /* ------------------------------------------------------------ meters */

  function setMeter(el, db) {
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    el.style.clipPath = 'inset(0 ' + (100 - pct).toFixed(1) + '% 0 0)';
  }

  let heardMs = 0;
  let lastLevelAt = 0;
  function micCheckLevel(db) {
    setMeter($('#mic-meter'), db);
    const now = performance.now();
    const dt = lastLevelAt ? Math.min(100, now - lastLevelAt) : 0;
    lastLevelAt = now;
    if (db > -38) heardMs += dt;
    if (heardMs > 350 && $('#btn-mic-ok').disabled) {
      $('#mic-heard').textContent = '✓ We can hear you.';
      $('#mic-heard').classList.add('ok');
      $('#btn-mic-ok').disabled = false;
    }
  }

  function trialLevel(db) {
    if (dock === 'recording' || dock === 'ready') setMeter($('#meter'), db);
  }

  /* ------------------------------------------------------------ flow */

  async function load() {
    show('s-loading');
    const r = await apiRetry('state');
    if (!r.data.ok) return fatal('The study could not be loaded. Please check your connection and reload the page.');
    S = r.data;
    route();
  }

  function applyState(state) {
    S = state;
    const local = localDone();
    queue = (S.trials || []).filter((t) => !local.has(t.position));
    const known = new Set([...(S.done_positions || []), ...local]);
    S.done = Math.min(S.total, known.size);
  }

  function route() {
    document.querySelectorAll('.n-total').forEach((el) => { el.textContent = S.total; });
    if (S.status === 'new') return showWelcome();
    applyState(S);
    updateProgress();
    if (S.status === 'completed' || !queue.length) return showDone();
    if (S.done === 0) return showMic();
    return showResume();
  }

  function showWelcome() {
    const p = envProblem();
    $('#env-warning').hidden = !p;
    $('#env-warning').textContent = p;
    show('s-welcome');
  }

  $('#consent').addEventListener('change', (e) => { $('#btn-welcome').disabled = !e.target.checked; });
  $('#btn-welcome').addEventListener('click', () => show('s-demo'));

  /* ------------------------------------------------- thông tin cá nhân */

  const countrySel = $('#f-country');
  const stateSel = $('#f-state-select');
  const stateTxt = $('#f-state-text');
  countrySel.innerHTML = '<option value="">— Select —</option>'
    + COUNTRIES.map((c) => `<option${c === 'United States' ? ' selected' : ''}>${c}</option>`).join('');
  stateSel.innerHTML = '<option value="">— Select —</option>' + US_STATES.map((s) => `<option>${s}</option>`).join('');
  function syncState() {
    const us = countrySel.value === 'United States';
    stateSel.hidden = !us;
    stateTxt.hidden = us;
    $('#state-label').textContent = us ? 'State' : 'State / province / region';
  }
  countrySel.addEventListener('change', syncState);
  syncState();

  async function submitDemo(skip) {
    const f = $('#demo-form');
    const btns = f.querySelectorAll('button');
    const us = countrySel.value === 'United States';
    const demo = skip ? null : {
      age: f.age.value.trim(),
      country: countrySel.value,
      state: us ? stateSel.value : stateTxt.value.trim(),
      city: f.city.value.trim(),
    };
    if (demo && demo.age !== '' && (!/^\d+$/.test(demo.age) || +demo.age < 1 || +demo.age > 120)) {
      f.age.focus();
      f.age.setCustomValidity('Please enter a valid age, or leave it empty.');
      f.age.reportValidity();
      return;
    }
    btns.forEach((b) => { b.disabled = true; });
    const r = await apiRetry('begin', {
      body: {
        consent: true,
        demographics: demo,
        device: TOUCH ? 'mobile' : 'desktop',
        input: TOUCH ? 'touch' : 'keyboard',
        screen: screen.width + 'x' + screen.height,
        external_id: EXT_ID || null,
      },
    });
    btns.forEach((b) => { b.disabled = false; });
    if (!r.data.ok) return fatal('Your answers could not be saved. Please check your connection and reload the page.');
    applyState(r.data);
    updateProgress();
    showMic();
  }
  $('#demo-form').addEventListener('submit', (e) => { e.preventDefault(); submitDemo(false); });
  $('#demo-form').age.addEventListener('input', (e) => e.target.setCustomValidity(''));
  $('#btn-skip').addEventListener('click', () => submitDemo(true));

  /* ---------------------------------------------------- kiểm tra micro */

  function showMic() {
    const p = envProblem();
    $('#mic-error').hidden = !p;
    $('#mic-error').textContent = p;
    $('#mic-ask').hidden = false;
    $('#mic-live').hidden = true;
    show('s-mic');
  }

  $('#btn-mic').addEventListener('click', async () => {
    const btn = $('#btn-mic');
    btn.disabled = true;
    $('#mic-error').hidden = true;
    try {
      await Rec.init();
    } catch (e) {
      btn.disabled = false;
      $('#mic-error').textContent = micErrorText(e);
      $('#mic-error').hidden = false;
      return;
    }
    btn.disabled = false;
    heardMs = 0;
    lastLevelAt = 0;
    Rec.onLevel = micCheckLevel;
    $('#mic-ask').hidden = true;
    $('#mic-live').hidden = false;
    // Vẫn cho đi tiếp sau 10 s nếu micro quá nhỏ (đã có thông báo gợi ý)
    setTimeout(() => {
      if ($('#btn-mic-ok').disabled && !$('#mic-live').hidden) {
        $('#mic-heard').textContent = 'We can barely hear you. Check that the right microphone is used and not muted, or move closer.';
        $('#btn-mic-ok').disabled = false;
      }
    }, 10000);
  });

  $('#btn-mic-ok').addEventListener('click', () => {
    Rec.onLevel = null;
    show('s-instructions');
  });
  $('#btn-start').addEventListener('click', () => startTrials());

  /* ------------------------------------------------------------ tiếp tục */

  function showResume() {
    $('#resume-pos').textContent = 'sentence ' + (S.done + 1) + ' of ' + S.total;
    $('#resume-error').hidden = true;
    show('s-resume');
  }

  $('#btn-resume').addEventListener('click', async () => {
    const btn = $('#btn-resume');
    btn.disabled = true;
    try {
      await Rec.init();
    } catch (e) {
      btn.disabled = false;
      $('#resume-error').textContent = micErrorText(e);
      $('#resume-error').hidden = false;
      return;
    }
    btn.disabled = false;
    startTrials();
  });

  /* ------------------------------------------------------------ các câu */

  function startTrials() {
    Rec.onLevel = trialLevel;
    Rec.onEnded = () => {
      if (dock === 'recording') {
        Rec.discard();
        clearTimers();
        setDock('ready');
        $('#trial-msg').textContent = 'The microphone stopped. Press Record to try this sentence again.';
      }
    };
    showDock();
    renderTrial(false);
  }

  function renderTrial(animate) {
    if (!queue.length) return finish();
    const t = queue[0];
    cur = { trial: t, restarts: 0, take: null, wav: null };
    const stage = $('#stage');
    const paint = () => {
      $('#count').textContent = 'Sentence ' + (S.done + 1) + ' of ' + S.total;
      $('#sentence').textContent = t.sentence;
      $('#trial-msg').textContent = '';
      const fig = $('#illus');
      if (t.image) {
        $('#illus-img').src = t.image;
        fig.hidden = false;
      } else {
        fig.hidden = true;
        $('#illus-img').removeAttribute('src');
      }
      // tải trước ảnh của câu sau
      if (queue[1] && queue[1].image) { const im = new Image(); im.src = queue[1].image; }
    };
    show('s-trial');
    if (!animate) {
      paint();
      setDock('ready');
      return;
    }
    stage.classList.add('leave');
    setTimeout(() => {
      paint();
      stage.classList.remove('leave');
      stage.classList.add('enter');
      void stage.offsetWidth;   // áp dụng vị trí bắt đầu trước khi chạy hiệu ứng
      stage.classList.remove('enter');
      setDock('ready');
    }, 230);
  }

  /* ------------------------------------------------------------ dock */

  function showDock() {
    $('#dock').hidden = false;
    measureDock();
  }
  function hideDock() {
    $('#dock').hidden = true;
    document.documentElement.style.setProperty('--dock-h', '0px');
    dock = 'off';
  }
  function measureDock() {
    const h = $('#dock').hidden ? 0 : $('#dock').offsetHeight;
    document.documentElement.style.setProperty('--dock-h', h + 'px');
  }
  window.addEventListener('resize', measureDock);

  function setDock(state) {
    dock = state;
    const el = $('#dock');
    el.className = 'dock ' + state;
    const label = $('#dock-label');
    const text = $('#rec-text');
    const btn = $('#btn-rec');
    $('#btn-restart').hidden = state !== 'recording';
    $('#btn-save-anyway').hidden = state !== 'review';
    btn.disabled = state === 'saving' || state === 'saved';
    if (state === 'ready') {
      label.textContent = 'Microphone on';
      text.textContent = 'Record';
      btn.setAttribute('aria-label', 'Record');
      $('#timer').textContent = '';
    } else if (state === 'recording') {
      label.textContent = 'Recording';
      text.textContent = 'Stop & save';
      btn.setAttribute('aria-label', 'Stop and save');
    } else if (state === 'review') {
      label.textContent = 'Not saved yet';
      $('#timer').textContent = '';
      text.textContent = 'Record again';
      btn.setAttribute('aria-label', 'Record again');
      setMeter($('#meter'), -120);
    } else if (state === 'saving') {
      label.textContent = 'Saving…';
      text.textContent = 'Saving…';
      setMeter($('#meter'), -120);
    } else if (state === 'saved') {
      label.textContent = 'Saved';
      text.textContent = 'Saved';
    }
    measureDock();
  }

  function clearTimers() {
    clearInterval(timerId);
    clearTimeout(autoStopId);
    timerId = 0;
    autoStopId = 0;
  }

  function startTimer() {
    const tick = () => {
      const s = Math.floor((performance.now() - Rec.t0) / 1000);
      $('#timer').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
    tick();
    timerId = setInterval(tick, 250);
    autoStopId = setTimeout(() => {
      if (dock === 'recording') {
        $('#trial-msg').textContent = 'The maximum recording length was reached, so your recording was saved.';
        stopAndSave();
      }
    }, (S.max_seconds || 40) * 1000);
  }

  async function onRecButton() {
    if (dock === 'ready' || dock === 'review') return startRecording();
    if (dock === 'recording') return stopAndSave();
    return undefined;
  }

  async function startRecording() {
    if (!Rec.alive()) {
      try {
        await Rec.init();
      } catch (e) {
        $('#trial-msg').textContent = micErrorText(e);
        return;
      }
    } else if (Rec.ctx.state !== 'running') {
      await Rec.ctx.resume().catch(() => {});
    }
    if (dock === 'review') cur.restarts++;
    cur.take = null;
    cur.wav = null;
    $('#trial-msg').textContent = '';
    Rec.start();
    setDock('recording');
    startTimer();
  }

  function restart() {
    if (dock !== 'recording') return;
    clearTimers();
    Rec.discard();
    cur.restarts++;
    Rec.start();
    setDock('recording');
    startTimer();
    $('#trial-msg').textContent = 'Restarted. Read the sentence again from the beginning.';
  }

  async function stopAndSave(force = false) {
    if (dock !== 'recording') return;
    clearTimers();
    const heldMs = performance.now() - Rec.t0;
    setDock('saving');
    const take = await Rec.stop();
    cur.take = take;
    if (!force && (heldMs < MIN_TAKE_MS || take.peakDb < QUIET_DB)) {
      $('#trial-msg').textContent = take.peakDb < QUIET_DB
        ? 'We could hear very little. Please move closer to the microphone and record again.'
        : 'That recording was very short. Please read the whole sentence.';
      setDock('review');
      return;
    }
    await saveTake();
  }

  async function saveTake() {
    setDock('saving');
    if (!cur.wav) cur.wav = await toWav(cur.take, S.sample_rate);
    const r = await apiRetry('upload', {
      raw: cur.wav,
      query: { pos: cur.trial.position, item: cur.trial.item_id, restarts: cur.restarts },
    });
    if (r.status === 200 && r.data.ok) {
      markLocalDone(cur.trial.position);
      S.done = Math.min(S.total, S.done + 1);
      updateProgress();
      queue.shift();
      setDock('saved');
      await sleep(SAVED_PAUSE_MS);
      if (!queue.length) return finish();
      renderTrial(true);
      return undefined;
    }
    if (r.status === 409) {
      // phiên đã đổi (vd. làm ở tab khác) → tải lại trạng thái
      hideDock();
      return load();
    }
    if (r.status === 413) {
      $('#trial-msg').textContent = 'That recording was too long to save. Please record it again a little faster.';
      setDock('review');
      $('#btn-save-anyway').hidden = true;
      return undefined;
    }
    hideDock();
    errorMode = 'upload';
    $('#err-msg').textContent = 'Your recording could not be saved.';
    document.querySelector('#s-error .muted').hidden = false;
    $('#btn-retry').textContent = 'Try again';
    show('s-error');
    return undefined;
  }

  $('#btn-retry').addEventListener('click', () => {
    if (errorMode !== 'upload' || !cur || !cur.take) return location.reload();
    show('s-trial');
    showDock();
    saveTake();
  });

  $('#btn-rec').addEventListener('click', onRecButton);
  $('#btn-restart').addEventListener('click', restart);
  $('#btn-save-anyway').addEventListener('click', () => { if (dock === 'review' && cur.take) saveTake(); });

  document.addEventListener('keydown', (e) => {
    if (!$('#s-trial').classList.contains('active') || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space' || e.key === ' ') {
      if (tag === 'BUTTON') return;   // trình duyệt tự bấm nút đang được chọn
      e.preventDefault();
      onRecButton();
    } else if ((e.key === 'r' || e.key === 'R') && dock === 'recording') {
      e.preventDefault();
      restart();
    }
  });

  // Trang bị ẩn khi đang ghi (khoá máy, chuyển app) → huỷ lần ghi này
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dock === 'recording') {
      clearTimers();
      Rec.discard();
      setDock('ready');
      $('#trial-msg').textContent = 'Recording stopped because you left the page. Please record this sentence again.';
    }
    if (document.visibilityState === 'visible' && Rec.ctx && Rec.ctx.state !== 'running') Rec.ctx.resume().catch(() => {});
  });

  window.addEventListener('beforeunload', (e) => {
    if (dock === 'recording' || dock === 'saving') {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ------------------------------------------------------------ kết thúc */

  function finish() {
    hideDock();
    Rec.close();
    showDone();
  }

  function showDone() {
    $('#progress').hidden = false;
    $('#progress-bar').style.width = '100%';
    $('#done-code').textContent = S.code;
    if (S.completion_url) {
      const u = S.completion_url.replace('{code}', encodeURIComponent(S.code));
      $('#done-link').href = u;
      $('#done-actions').hidden = false;
    }
    show('s-done');
  }

  load().catch(() => fatal('The study could not be loaded. Please check your connection and reload the page.'));
})();
