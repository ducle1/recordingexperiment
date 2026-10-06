import crypto from 'node:crypto';
import { config, MAX_UPLOAD_BYTES } from '../lib/config.js';
import {
  parseUrl, parseCookies, setCookie, readBody, readRaw, sendHtml, sendJson, redirect, sendDownload,
  h, sign, safeEqual, fmtLocal, durationStr, toIso, postAllowed,
} from '../lib/http.js';
import {
  loadStimuli, stimulusById, groupsList, fixedOrder, orderViolations, summarizeFiles, profilePath,
  CODE_RE, PID_COOKIE, wavDurationMs, loadImages, imageUrl,
} from '../lib/experiment.js';
import { listFiles, getJson, putJson, putFile, delFiles, getStream } from '../lib/store.js';

const ADMIN_COOKIE = 'rec_admin';
const ADMIN_HOURS = 12;
const AUDIO_RE = /^p\/R[A-Z0-9]{7}\/\d+_[A-Za-z0-9]+_r\d+\.wav$/;
const IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/* ------------------------------------------------------------ auth */

function adminCookieValid(v) {
  if (!v || !config.adminPassword) return false;
  const [exp, sig] = String(v).split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, adminSig(exp));
}
const csrfFor = (cookieVal) => sign('csrf:' + cookieVal).slice(0, 32);
// Đổi mật khẩu → mọi phiên admin cũ hết hiệu lực
const pwTag = () => crypto.createHash('sha256').update(config.adminPassword).digest('hex').slice(0, 12);
const adminSig = (exp) => sign('admin:' + pwTag() + ':' + exp);

/* ------------------------------------------------------- dữ liệu */

const profileCache = new Map();   // hồ sơ gần như không đổi → giữ trong bộ nhớ của function

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

function buildParticipant(code, profile, sum) {
  const order = (profile && profile.order) || [];
  const total = order.length || loadStimuli().length;
  const recordings = [];
  order.forEach((itemId, i) => {
    const r = sum.recs.get(i + 1);
    if (r && r.item_id === itemId) recordings.push(r);
  });
  // bản ghi không khớp hồ sơ (hiếm): vẫn liệt kê
  if (!order.length) recordings.push(...[...sum.recs.values()].sort((a, b) => a.position - b.position));
  const done = recordings.length;
  const created = profile && profile.created_at ? new Date(profile.created_at) : (sum.lastActivity || new Date());
  const lastRec = recordings.reduce((m, r) => (!m || r.uploadedAt > m ? r.uploadedAt : m), null);
  let status;
  if (total && done >= total) status = 'completed';
  else if (sum.lastActivity && sum.lastActivity >= new Date(Date.now() - config.abandonMinutes * 60000)) status = 'in_progress';
  else status = 'abandoned';
  const audioMs = recordings.reduce((s, r) => s + (wavDurationMs(r.size, config.sampleRate) || 0), 0);
  return {
    code, profile, order, total, done, recordings, status, excluded: sum.excluded,
    created, lastActivity: sum.lastActivity, lastRec,
    timeMs: lastRec ? lastRec - created : null,
    audioMs, bytes: recordings.reduce((s, r) => s + r.size, 0),
  };
}

async function loadParticipants(prefix = 'p/') {
  const files = await listFiles(prefix);
  const by = new Map();
  for (const f of files) {
    const code = f.pathname.split('/')[1];
    if (!CODE_RE.test(code || '')) continue;
    if (!by.has(code)) by.set(code, []);
    by.get(code).push(f);
  }
  const list = await mapLimit([...by], 8, async ([code, fl]) => {
    const sum = summarizeFiles(fl);
    let profile = null;
    if (sum.profileFile) {
      const stamp = new Date(sum.profileFile.uploadedAt).getTime() + ':' + sum.profileFile.size;
      const c = profileCache.get(code);
      if (c && c.stamp === stamp) profile = c.data;
      else {
        profile = await getJson(profilePath(code), { fresh: false });
        if (profile) profileCache.set(code, { stamp, data: profile });
      }
    }
    return buildParticipant(code, profile, sum);
  });
  return list.sort((a, b) => b.created - a.created);
}

/* ---------------------------------------------------------- handler */

export default async function handler(req, res) {
  try {
    const url = parseUrl(req);
    const ck = parseCookies(req.headers.cookie);
    const action = url.searchParams.get('action') || '';

    if (!config.adminPassword) {
      return sendHtml(res, 500, layout('Chưa cấu hình', null, `<div class="login"><div class="panel"><h1>Chưa đặt mật khẩu</h1>
        <p>Thêm biến môi trường <code>ADMIN_PASSWORD</code> trong Vercel → Settings → Environment Variables, rồi Redeploy.</p></div></div>`));
    }

    // ----- đăng nhập
    if (!adminCookieValid(ck[ADMIN_COOKIE])) {
      if (action) return sendJson(res, 401, { ok: false, error: 'login_required' });
      let err = '';
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body.do === 'login' && body.password && safeEqual(body.password, config.adminPassword)) {
          const exp = Math.floor(Date.now() / 1000) + ADMIN_HOURS * 3600;
          setCookie(req, res, ADMIN_COOKIE, `${exp}.${adminSig(exp)}`, { maxAge: ADMIN_HOURS * 3600 });
          return redirect(res, '/admin');
        }
        await new Promise((r) => setTimeout(r, 800));
        err = 'Sai mật khẩu.';
      }
      return sendHtml(res, err ? 401 : 200, layout('Đăng nhập', null, `
        <div class="login"><form method="post" action="/admin" class="panel">
          <p class="eyebrow">Recording experiment</p>
          <h1>Quản trị thí nghiệm</h1>
          ${err ? `<p class="err">${h(err)}</p>` : ''}
          <input type="hidden" name="do" value="login">
          <label>Mật khẩu<input type="password" name="password" autocomplete="current-password" autofocus required></label>
          <button class="btn primary">Đăng nhập</button>
        </form></div>`));
    }

    const csrf = csrfFor(ck[ADMIN_COOKIE]);

    // ----- API cho trang admin (JSON / file)
    if (action) return adminApi(req, res, url, action, csrf);

    // ----- hành động từ form
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.csrf || !safeEqual(body.csrf, csrf)) {
        return sendHtml(res, 403, 'Phiên làm việc đã hết hạn. Tải lại trang rồi thử lại.');
      }
      const code = CODE_RE.test(body.code || '') ? body.code : null;
      if (body.do === 'logout') {
        setCookie(req, res, ADMIN_COOKIE, '', { maxAge: 0 });
        return redirect(res, '/admin');
      }
      if (body.do === 'test_as_new') {
        setCookie(req, res, PID_COOKIE, '', { maxAge: 0 });
        return redirect(res, '/');
      }
      if (code && (body.do === 'exclude' || body.do === 'include')) {
        if (body.do === 'exclude') await putFile(`p/${code}/_excluded`, Buffer.from(new Date().toISOString()), 'text/plain');
        else await delFiles([`p/${code}/_excluded`]);
        return redirect(res, `/admin?view=p&code=${code}`);
      }
      if (code && (body.do === 'delete' || body.do === 'reset')) {
        const files = await listFiles(`p/${code}/`);
        const del = body.do === 'delete' ? files : files.filter((f) => f.pathname.endsWith('.wav'));
        await delFiles(del.map((f) => f.pathname));
        if (body.do === 'reset') {
          const prof = await getJson(profilePath(code));
          if (prof) await putJson(profilePath(code), { ...prof, reset_count: (prof.reset_count || 0) + 1, reset_at: new Date().toISOString() });
        }
        profileCache.delete(code);
        return redirect(res, body.do === 'delete' ? '/admin' : `/admin?view=p&code=${code}`);
      }
      return redirect(res, '/admin');
    }

    // ----- xuất CSV
    const exp = url.searchParams.get('export');
    if (exp) return exportCsv(req, res, exp);

    // ----- trang
    const view = url.searchParams.get('view') || '';
    if (view === 'p') return sendHtml(res, 200, await viewParticipant(url.searchParams.get('code'), csrf));
    if (view === 's') {
      const item = url.searchParams.get('item');
      return sendHtml(res, 200, item ? await viewSentence(item, csrf) : await viewSentences(csrf));
    }
    if (view === 'order') return sendHtml(res, 200, viewOrder(csrf));
    return sendHtml(res, 200, await viewHome(url, csrf));
  } catch (e) {
    console.error(e);
    return sendHtml(res, 500, layout('Lỗi', null, `<div class="panel"><h1>Lỗi máy chủ</h1><pre>${h(e.message || e)}</pre></div>`));
  }
}

/* ------------------------------------------------------- API JSON / file */

async function adminApi(req, res, url, action, csrf) {
  if (action === 'audio') {
    const p = url.searchParams.get('path') || '';
    if (!AUDIO_RE.test(p)) return sendJson(res, 400, { ok: false });
    const r = await getStream(p);
    if (!r) return sendJson(res, 404, { ok: false });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (r.size) res.setHeader('Content-Length', r.size);
    if (url.searchParams.get('dl')) {
      const name = String(url.searchParams.get('dl')).replace(/[^\w.-]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    }
    return r.stream.pipe(res);
  }

  if (action === 'data') {
    const list = await loadParticipants();
    return sendJson(res, 200, {
      ok: true,
      sample_rate: config.sampleRate,
      groups: groupsList(),
      participants: list.map((p) => ({
        code: p.code, status: p.status, excluded: p.excluded, done: p.done, total: p.total,
        device: p.profile?.device || '', created: p.created, demographics: p.profile?.demographics || null,
        recordings: p.recordings.map((r) => {
          const s = stimulusById(r.item_id);
          return {
            path: r.pathname, size: r.size, position: r.position, item_id: r.item_id, restarts: r.restarts,
            group: s?.group || '', group_label: s?.group_label || '', sentence: s?.sentence || '', uploaded_at: r.uploadedAt,
          };
        }),
      })),
    });
  }

  if (action === 'image' || action === 'image_delete') {
    if (req.method !== 'POST' || !postAllowed(req) || !safeEqual(String(req.headers['x-csrf'] || ''), csrf)) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }
    const item = url.searchParams.get('item') || '';
    if (!stimulusById(item)) return sendJson(res, 400, { ok: false, error: 'bad_item' });
    const manifest = (await getJson('cfg/images.json', { fresh: true })) || { items: {} };
    manifest.items = manifest.items || {};
    const old = manifest.items[item];
    if (action === 'image') {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      const ext = IMG_TYPES[type];
      if (!ext) return sendJson(res, 415, { ok: false, error: 'bad_type' });
      let buf;
      try { buf = await readRaw(req, MAX_UPLOAD_BYTES); } catch (e) {
        if (e.code === 'too_large') return sendJson(res, 413, { ok: false, error: 'too_large' });
        throw e;
      }
      if (!buf.length) return sendJson(res, 400, { ok: false, error: 'empty' });
      const v = Date.now();
      const path = `img/${item}-${v}.${ext}`;
      await putFile(path, buf, type);
      manifest.items[item] = { path, v, type, size: buf.length };
    } else {
      delete manifest.items[item];
    }
    await putJson('cfg/images.json', manifest);
    if (old && old.path) await delFiles([old.path]).catch(() => {});
    return sendJson(res, 200, { ok: true, url: imageUrl(manifest.items[item]) });
  }

  return sendJson(res, 400, { ok: false, error: 'unknown_action' });
}

/* ---------------------------------------------------------- layout */

function layout(title, csrf, content, { scripts = true } = {}) {
  const loggedIn = csrf !== null;
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${loggedIn ? `<meta name="csrf" content="${h(csrf)}">` : ''}
<title>${h(title)} · Recording Admin</title>
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/admin.css?v=1">
</head>
<body>
${loggedIn ? `<header class="top">
  <a class="brand" href="/admin">Recording Admin</a>
  <nav>
    <a href="/admin">Tổng quan</a>
    <a href="/admin?view=s">Câu &amp; ảnh</a>
    <a href="/admin?view=order">Thứ tự câu</a>
    <span class="dd">
      <a href="#" onclick="return false">Xuất dữ liệu ▾</a>
      <span class="dd-menu">
        <a href="#" data-action="export-analysis">CSV kèm phân tích cao độ &amp; độ lớn</a>
        <a href="/admin?export=recordings">CSV danh sách bản ghi</a>
        <a href="/admin?export=participants">CSV người tham gia</a>
        <a href="#" data-action="zip-all">Tải tất cả bản ghi (.zip)</a>
      </span>
    </span>
    <form method="post" action="/admin" class="inline" data-clear-local>
      <input type="hidden" name="csrf" value="${h(csrf)}">
      <button name="do" value="test_as_new" class="link" title="Xoá mã người tham gia trên trình duyệt này và mở bài như người mới">Làm thử như người mới</button>
    </form>
    <form method="post" action="/admin" class="inline">
      <input type="hidden" name="csrf" value="${h(csrf)}">
      <button name="do" value="logout" class="link">Đăng xuất</button>
    </form>
  </nav>
</header>
<div class="job" id="job" hidden><span id="job-text"></span><span class="job-bar"><span id="job-bar"></span></span></div>` : ''}
<main class="wrap">
${content}
</main>
${loggedIn && scripts ? '<script src="/assets/admin.js?v=1" defer></script>' : ''}
</body>
</html>`;
}

const STATUS = {
  completed: ['Hoàn thành', 'ok'],
  in_progress: ['Đang làm', 'live'],
  abandoned: ['Bỏ dở', 'warn'],
};
function statusBadge(p) {
  if (p.done === 0 && p.status !== 'in_progress') return '<span class="st mute">Chưa ghi câu nào</span>';
  const [t, c] = STATUS[p.status] || ['?', 'mute'];
  return `<span class="st ${c}">${t}</span>`;
}
const excludedBadge = (p) => (p.excluded ? ' <span class="st bad">Đã loại</span>' : '');
const deviceBadge = (p) => {
  const d = p.profile?.device;
  return d ? `<span class="st dev">${d === 'mobile' ? 'Điện thoại' : 'Máy tính'}</span>` : '';
};
const groupBadge = (s) => (s ? `<span class="gb g-${h(s.group)}" title="${h(s.group_label)}">${h(shortGroup(s))}</span>` : '');
function shortGroup(s) {
  return ({
    baseline: 'Baseline', extreme: 'Extreme', evaluative: 'Evaluative', dimensional: 'Dimensional', should: 'Should + VP', must: 'Must + VP',
  })[s.group] || s.group_label;
}
const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const fmtSec = (ms) => (ms === null || ms === undefined ? '' : (ms / 1000).toFixed(1).replace('.', ',') + ' s');
function demoText(d) {
  if (!d) return '';
  return [d.age ? d.age + ' tuổi' : '', [d.city, d.state, d.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------- tổng quan */

async function viewHome(url, csrf) {
  const all = await loadParticipants();
  const filter = url.searchParams.get('f') || 'all';
  const counts = {
    all: all.length,
    completed: all.filter((p) => p.status === 'completed' && !p.excluded).length,
    in_progress: all.filter((p) => p.status === 'in_progress' && !p.excluded).length,
    abandoned: all.filter((p) => p.status === 'abandoned' && !p.excluded).length,
    excluded: all.filter((p) => p.excluded).length,
  };
  const shown = all.filter((p) => (filter === 'all' ? true : filter === 'excluded' ? p.excluded : p.status === filter && !p.excluded));
  const recCount = all.reduce((s, p) => s + p.done, 0);
  const bytes = all.reduce((s, p) => s + p.bytes, 0);
  const audioMs = all.reduce((s, p) => s + p.audioMs, 0);
  const doneTimes = all.filter((p) => p.status === 'completed' && p.timeMs > 0).map((p) => p.timeMs).sort((a, b) => a - b);
  const median = doneTimes.length ? doneTimes[Math.floor(doneTimes.length / 2)] : null;
  const total = loadStimuli().length;

  const tab = (k, label) => `<a class="tab${filter === k ? ' on' : ''}" href="/admin${k === 'all' ? '' : '?f=' + k}">${label} <b>${counts[k]}</b></a>`;
  const rows = shown.map((p) => {
    const pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
    return `<tr data-href="/admin?view=p&amp;code=${p.code}"${p.excluded ? ' class="dim"' : ''}>
      <td class="mono"><a href="/admin?view=p&amp;code=${p.code}">${p.code}</a></td>
      <td>${statusBadge(p)}${excludedBadge(p)}</td>
      <td><span class="prog"><span style="width:${pct}%"></span></span> <span class="tiny nowrap">${p.done}/${p.total}</span></td>
      <td>${deviceBadge(p)}</td>
      <td class="tiny">${h(demoText(p.profile?.demographics)) || '<span class="mute-t">—</span>'}</td>
      <td class="nowrap">${fmtLocal(p.created)}</td>
      <td class="nowrap">${fmtLocal(p.lastActivity)}</td>
      <td class="r nowrap">${p.status === 'completed' ? durationStr(p.timeMs) : ''}</td>
    </tr>`;
  }).join('');

  return layout('Tổng quan', csrf, `
    <h1>Tổng quan</h1>
    <div class="stats">
      <div class="panel"><div class="lbl">Hoàn thành</div><div class="big">${counts.completed}</div><div class="sub">${counts.in_progress} đang làm · ${counts.abandoned} bỏ dở${counts.excluded ? ` · ${counts.excluded} đã loại` : ''}</div></div>
      <div class="panel"><div class="lbl">Bản ghi đã lưu</div><div class="big">${recCount}</div><div class="sub">${total} câu mỗi người · ≈ ${durationStr(audioMs) || '0:00'} âm thanh</div></div>
      <div class="panel"><div class="lbl">Thời gian làm (trung vị)</div><div class="big">${median ? durationStr(median) : '—'}</div><div class="sub">tính trên người đã hoàn thành</div></div>
      <div class="panel"><div class="lbl">Dung lượng bản ghi</div><div class="big">${fmtBytes(bytes)}</div><div class="sub">Vercel Blob gói miễn phí: 1 GB</div></div>
    </div>
    <div class="toolbar">
      <nav class="tabs">${tab('all', 'Tất cả')}${tab('completed', 'Hoàn thành')}${tab('in_progress', 'Đang làm')}${tab('abandoned', 'Bỏ dở')}${tab('excluded', 'Đã loại')}</nav>
      <div class="tools">
        <button class="btn" data-action="export-analysis">Xuất CSV kèm phân tích</button>
        <button class="btn" data-action="zip-all">Tải tất cả (.zip)</button>
      </div>
    </div>
    <div class="table-wrap"><table class="list">
      <thead><tr><th>Mã</th><th>Trạng thái</th><th>Tiến độ</th><th>Thiết bị</th><th>Thông tin</th><th>Bắt đầu</th><th>Hoạt động cuối</th><th class="r">Thời gian làm</th></tr></thead>
      <tbody>${rows || `<tr class="static"><td colspan="8" class="empty">${all.length ? 'Không có ai trong mục này.' : 'Chưa có người tham gia nào. Gửi link trang chính cho người tham gia, hoặc bấm “Làm thử như người mới” để tự chạy thử.'}</td></tr>`}</tbody>
    </table></div>
    <p class="note">“Bỏ dở” = chưa xong và không hoạt động quá ${config.abandonMinutes} phút. Người đó mở lại link trên cùng trình duyệt thì vẫn làm tiếp được từ câu chưa lưu.</p>`);
}

/* ------------------------------------------------------- 1 người tham gia */

function recArticle(r, s, p, { showCode = false } = {}) {
  const dur = wavDurationMs(r.size, config.sampleRate);
  const fname = `${p.code}_${String(r.position).padStart(2, '0')}_${r.item_id}.wav`;
  return `<article class="rec" data-path="${h(r.pathname)}" data-size="${r.size}" data-t="${r.uploadedAt.getTime()}" data-name="${h(fname)}">
    <div class="rec-head">
      ${showCode ? `<a class="mono code" href="/admin?view=p&amp;code=${p.code}">${p.code}</a>${p.excluded ? ' <span class="st bad">Đã loại</span>' : ''}` : `<span class="pos">${r.position}</span>`}
      ${showCode ? '' : groupBadge(s)}
      ${showCode ? '' : `<a class="sent" href="/admin?view=s&amp;item=${h(r.item_id)}">${h(s?.sentence || r.item_id)}</a>`}
      <span class="tiny meta-line">${fmtSec(dur)}${r.restarts ? ` · ghi lại ${r.restarts} lần` : ''} · ${fmtLocal(r.uploadedAt)}
        · <a href="/admin?action=audio&amp;path=${encodeURIComponent(r.pathname)}&amp;dl=${encodeURIComponent(fname)}">Tải .wav</a></span>
    </div>
    <div class="rec-body">
      <button class="play" type="button" aria-label="Phát"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="i-play" d="M8 5.5v13l11-6.5z"/><g class="i-pause"><rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/></g></svg></button>
      <div class="chart"><canvas></canvas><div class="chart-msg">Đang phân tích…</div></div>
      <dl class="nums"></dl>
    </div>
  </article>`;
}

async function viewParticipant(code, csrf) {
  if (!CODE_RE.test(code || '')) return layout('Không tìm thấy', csrf, '<div class="panel">Mã không hợp lệ. <a href="/admin">← Quay lại</a></div>');
  const [p] = await loadParticipants(`p/${code}/`);
  if (!p) return layout('Không tìm thấy', csrf, `<div class="panel">Không có dữ liệu cho mã ${h(code)}. <a href="/admin">← Quay lại</a></div>`);
  const pr = p.profile || {};
  const recByPos = new Map(p.recordings.map((r) => [r.position, r]));
  const items = (p.order.length ? p.order : p.recordings.map((r) => r.item_id));
  const list = items.map((itemId, i) => {
    const s = stimulusById(itemId);
    const r = recByPos.get(i + 1);
    if (r) return recArticle(r, s, p);
    return `<article class="rec pending"><div class="rec-head"><span class="pos">${i + 1}</span>${groupBadge(s)}<span class="sent">${h(s?.sentence || itemId)}</span><span class="tiny meta-line">Chưa ghi</span></div></article>`;
  }).join('');
  const form = (doName, label, cls = 'btn', confirm = '') => `<form method="post" action="/admin" class="inline"${confirm ? ` data-confirm="${h(confirm)}"` : ''}>
      <input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="code" value="${p.code}">
      <button class="${cls}" name="do" value="${doName}">${label}</button></form>`;
  return layout(p.code, csrf, `
    <p class="crumb"><a href="/admin">← Tổng quan</a></p>
    <div class="p-head">
      <div>
        <h1><span class="mono">${p.code}</span> ${statusBadge(p)}${excludedBadge(p)} ${deviceBadge(p)}</h1>
        <p class="meta">${p.done}/${p.total} câu · bắt đầu ${fmtLocal(p.created)} · hoạt động cuối ${fmtLocal(p.lastActivity)}${p.status === 'completed' ? ` · làm trong ${durationStr(p.timeMs)}` : ''}</p>
      </div>
      <div class="p-actions">
        ${p.done ? `<button class="btn primary" data-action="zip-one" data-code="${p.code}">Tải bản ghi (.zip)</button>` : ''}
        ${p.excluded ? form('include', 'Bỏ loại') : form('exclude', 'Loại khỏi phân tích')}
        ${p.done ? form('reset', 'Xoá bản ghi', 'btn danger', `Xoá toàn bộ ${p.done} bản ghi của ${p.code}? Người này sẽ làm lại từ câu 1 (giữ nguyên mã).`) : ''}
        ${form('delete', 'Xoá người này', 'btn danger', `Xoá hẳn ${p.code} cùng mọi bản ghi? Không khôi phục được.`)}
      </div>
    </div>
    <div class="facts panel">
      <div><span class="lbl">Thông tin</span>${h(demoText(pr.demographics)) || (pr.demo_status === 'skipped' ? 'Bỏ qua' : '—')}</div>
      <div><span class="lbl">Thiết bị</span>${h(pr.device === 'mobile' ? 'Điện thoại / máy tính bảng' : pr.device ? 'Máy tính' : '—')}${pr.screen ? ` · màn hình ${h(pr.screen)}` : ''}</div>
      <div><span class="lbl">Thứ tự câu</span>${pr.order_mode === 'random' ? 'Ngẫu nhiên riêng' : `Cố định (${h(pr.order_seed || '')})`}</div>
      ${pr.external_id ? `<div><span class="lbl">Mã bên ngoài</span><span class="mono">${h(pr.external_id)}</span></div>` : ''}
      <div class="wide"><span class="lbl">Trình duyệt</span><span class="tiny">${h(pr.user_agent || '—')}</span></div>
    </div>
    <div class="legend-row">
      <h2>Bản ghi</h2>
      <p class="legend"><span class="k k-f0"></span> Cao độ F0 (Hz) <span class="k k-db"></span> Độ lớn (dB) · bấm vào biểu đồ để nghe từ điểm đó, kéo để chọn một đoạn và đo riêng (vd. từ “totally”)</p>
    </div>
    <div class="recs">${list}</div>`);
}

/* ----------------------------------------------------------- theo câu */

async function viewSentences(csrf) {
  const [all, images] = await Promise.all([loadParticipants(), loadImages()]);
  const counts = new Map();
  for (const p of all) for (const r of p.recordings) counts.set(r.item_id, (counts.get(r.item_id) || 0) + 1);
  const rows = loadStimuli().map((s) => {
    const img = images[s.item_id];
    return `<tr data-item="${h(s.item_id)}">
      <td class="mono">${h(s.item_id)}</td>
      <td>${groupBadge(s)}</td>
      <td><a href="/admin?view=s&amp;item=${h(s.item_id)}">${h(s.sentence)}</a></td>
      <td class="r">${counts.get(s.item_id) || 0}</td>
      <td class="img-cell">
        <span class="thumb">${img ? `<img src="${h(imageUrl(img))}" alt="">` : ''}</span>
        <label class="btn small">${img ? 'Đổi ảnh' : 'Thêm ảnh'}<input type="file" accept="image/jpeg,image/png,image/webp" data-upload="${h(s.item_id)}" hidden></label>
        ${img ? `<button class="btn small danger" data-img-delete="${h(s.item_id)}">Xoá</button>` : ''}
      </td>
    </tr>`;
  }).join('');
  return layout('Câu & ảnh', csrf, `
    <h1>Câu &amp; ảnh minh hoạ</h1>
    <p class="note">Ảnh hiện phía trên câu tương ứng khi người tham gia đọc. Ảnh lớn được tự thu nhỏ còn tối đa 1600 px trước khi tải lên. Bấm vào câu để nghe và so sánh bản ghi của mọi người.</p>
    <div class="table-wrap"><table class="list sentences">
      <thead><tr><th>Mã</th><th>Nhóm</th><th>Câu</th><th class="r">Bản ghi</th><th>Ảnh minh hoạ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`);
}

async function viewSentence(item, csrf) {
  const s = stimulusById(item);
  if (!s) return layout('Không tìm thấy', csrf, '<div class="panel">Không có câu này. <a href="/admin?view=s">← Quay lại</a></div>');
  const all = await loadParticipants();
  const recs = [];
  for (const p of all) for (const r of p.recordings) if (r.item_id === item) recs.push({ r, p });
  recs.sort((a, b) => a.r.uploadedAt - b.r.uploadedAt);
  return layout(s.item_id, csrf, `
    <p class="crumb"><a href="/admin?view=s">← Câu &amp; ảnh</a></p>
    <h1><span class="mono">${h(s.item_id)}</span> ${groupBadge(s)}</h1>
    <p class="sentence-big">${h(s.sentence)}</p>
    ${recs.length ? `<div class="panel overlay-panel">
      <div class="overlay-head"><b>Đường cao độ của ${recs.length} người</b><span class="tiny">trục ngang chuẩn hoá theo thời lượng lời nói (0–100%), mỗi đường là một người, đường đậm là trung bình</span></div>
      <canvas id="overlay"></canvas>
    </div>` : ''}
    <div class="legend-row">
      <h2>Bản ghi (${recs.length})</h2>
      <p class="legend"><span class="k k-f0"></span> Cao độ F0 (Hz) <span class="k k-db"></span> Độ lớn (dB)</p>
    </div>
    <div class="recs" data-overlay="1">${recs.map(({ r, p }) => recArticle(r, s, p, { showCode: true })).join('') || '<div class="panel empty">Chưa có ai ghi câu này.</div>'}</div>`);
}

/* ---------------------------------------------------------- thứ tự câu */

function viewOrder(csrf) {
  const order = fixedOrder();
  const bad = orderViolations(order);
  const rows = order.map((s, i) => `<tr${i > 0 && order[i - 1].group === s.group ? ' class="same"' : ''}>
    <td class="r mono">${i + 1}</td><td>${groupBadge(s)}</td><td class="mono">${h(s.item_id)}</td><td>${h(s.sentence)}</td></tr>`).join('');
  return layout('Thứ tự câu', csrf, `
    <h1>Thứ tự câu</h1>
    <div class="panel">
      <p class="${bad.length ? 'bad-t' : 'ok-t'}"><b>${bad.length ? `Vi phạm ràng buộc ở vị trí ${bad.join(', ')}` : '✓ Thoả ràng buộc'}</b>: hai câu cùng nhóm không đứng liền nhau; riêng nhóm baseline tối đa ${config.baselineMaxRun} câu liền nhau.</p>
      <p class="note">Chế độ hiện tại: <b>${config.orderMode === 'random' ? 'mỗi người một thứ tự ngẫu nhiên riêng (bảng dưới chỉ là ví dụ)' : 'mọi người đọc cùng danh sách này'}</b>.
      Đổi bằng biến môi trường <code>ORDER_MODE</code> (<code>fixed</code> / <code>random</code>) và <code>ORDER_SEED</code> trong Vercel. Người đã bắt đầu giữ nguyên thứ tự của mình.</p>
    </div>
    <div class="table-wrap" style="margin-top:14px"><table class="list order">
      <thead><tr><th class="r">#</th><th>Nhóm</th><th>Mã</th><th>Câu</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note">Hàng tô nền: cùng nhóm với câu ngay trước (chỉ được phép với nhóm baseline).</p>`);
}

/* ---------------------------------------------------------------- CSV */

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

async function exportCsv(req, res, kind) {
  const all = await loadParticipants();
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'participants') {
    const rows = [['code', 'status', 'excluded', 'recordings', 'total', 'device', 'age', 'country', 'state', 'city', 'screen', 'external_id', 'order_mode', 'started_at', 'last_activity', 'minutes', 'user_agent']];
    for (const p of all) {
      const d = p.profile?.demographics || {};
      rows.push([p.code, p.status, p.excluded ? 1 : 0, p.done, p.total, p.profile?.device, d.age, d.country, d.state, d.city,
        p.profile?.screen, p.profile?.external_id, p.profile?.order_mode, toIso(p.created), toIso(p.lastActivity),
        p.status === 'completed' && p.timeMs ? (p.timeMs / 60000).toFixed(1) : '', p.profile?.user_agent]);
    }
    return sendDownload(req, res, `participants-${stamp}.csv`, 'text/csv; charset=utf-8', csv(rows));
  }
  const rows = [['code', 'excluded', 'device', 'position', 'item_id', 'group', 'group_label', 'sentence', 'restarts', 'duration_s', 'file', 'uploaded_at']];
  for (const p of all) {
    for (const r of p.recordings) {
      const s = stimulusById(r.item_id);
      rows.push([p.code, p.excluded ? 1 : 0, p.profile?.device, r.position, r.item_id, s?.group, s?.group_label, s?.sentence, r.restarts,
        ((wavDurationMs(r.size, config.sampleRate) || 0) / 1000).toFixed(3), `${p.code}_${String(r.position).padStart(2, '0')}_${r.item_id}.wav`, toIso(r.uploadedAt)]);
    }
  }
  return sendDownload(req, res, `recordings-${stamp}.csv`, 'text/csv; charset=utf-8', csv(rows));
}
