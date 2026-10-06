import crypto from 'node:crypto';
import { config } from './config.js';
import STIMULI_CSV from './stimuli.js';   // sinh từ stimuli.csv (npm run build)
import { parseCookies, setCookie, sign, safeEqual } from './http.js';
import { getJson, listFiles } from './store.js';

/* ============================================================ Câu */

let stimuliCache = null;

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Đọc stimuli.csv. Cột: item_id, group, group_label, sentence */
export function loadStimuli() {
  if (stimuliCache) return stimuliCache;
  const rows = parseCsv(STIMULI_CSV);
  const header = rows.shift().map((x) => x.trim().toLowerCase());
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const groupOrder = new Map();
  const items = [];
  for (const raw of rows) {
    const r = {};
    header.forEach((k, i) => { r[k] = clean(raw[i]); });
    if (!r.sentence) continue;
    const group = (r.group || 'other').toLowerCase();
    if (!groupOrder.has(group)) groupOrder.set(group, groupOrder.size + 1);
    items.push({
      item_id: r.item_id || `I${items.length + 1}`,
      group,
      group_label: r.group_label || group,
      group_order: groupOrder.get(group),
      item_order: items.length + 1,
      sentence: r.sentence,
    });
  }
  stimuliCache = items;
  return items;
}

export function stimulusById(id) {
  return loadStimuli().find((s) => s.item_id === id) || null;
}

export function groupsList() {
  const seen = new Map();
  for (const s of loadStimuli()) if (!seen.has(s.group)) seen.set(s.group, s.group_label);
  return [...seen].map(([id, label]) => ({ id, label }));
}

/* ======================================================= Thứ tự câu */

/** PRNG có hạt giống (mulberry32): cùng hạt giống luôn ra cùng thứ tự ở mọi máy chủ. */
function seededRand(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return (n) => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
const cryptoRand = (n) => crypto.randomInt(n);

function shuffle(a, rand) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const maxRunFor = (group) => (group === config.baselineGroup ? config.baselineMaxRun : config.otherMaxRun);

/**
 * Kiểm tra ràng buộc trong requirement: các câu cùng nhóm không đứng cạnh nhau,
 * riêng nhóm baseline không quá 2 câu liền nhau. Trả về danh sách vi phạm (rỗng = hợp lệ).
 */
export function orderViolations(items) {
  const out = [];
  let run = 0;
  for (let i = 0; i < items.length; i++) {
    run = i > 0 && items[i].group === items[i - 1].group ? run + 1 : 1;
    if (run > maxRunFor(items[i].group)) out.push(i + 1);
  }
  return out;
}

/** Xáo trộn bằng lấy mẫu loại bỏ cho tới khi hợp lệ: mọi thứ tự hợp lệ có xác suất như nhau. */
function constrainedShuffle(items, rand) {
  for (let t = 0; t < 500000; t++) {
    const perm = shuffle(items, rand);
    if (!orderViolations(perm).length) return perm;
  }
  throw new Error('Không tìm được thứ tự thoả ràng buộc nhóm');
}

let fixedCache = null;
export function fixedOrder() {
  if (!fixedCache) fixedCache = constrainedShuffle(loadStimuli(), seededRand(config.orderSeed));
  return fixedCache;
}

/** Thứ tự câu cho 1 người mới (danh sách item_id). */
export function newOrder() {
  const items = config.orderMode === 'random' ? constrainedShuffle(loadStimuli(), cryptoRand) : fixedOrder();
  return items.map((s) => s.item_id);
}

/* ================================================ Nhận diện người tham gia */

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^R[A-Z0-9]{7}$/;
export const PID_COOKIE = 'rec_pid';

function newCode() {
  let s = 'R';
  for (let i = 0; i < 7; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

export const tokenFor = (code) => `${code}.${sign('pid:' + code).slice(0, 24)}`;

function codeFromToken(tok) {
  const [code, sig] = String(tok || '').split('.');
  if (!CODE_RE.test(code || '') || !sig) return null;
  return safeEqual(sig, sign('pid:' + code).slice(0, 24)) ? code : null;
}

/**
 * Nhận diện người tham gia như trang reading:
 *  - cookie rec_pid (1 năm, HttpOnly, có chữ ký nên không giả được)
 *  - dự phòng: trình duyệt gửi lại mã đã lưu trong localStorage (header X-Rec-Pid)
 *    nếu cookie bị xoá. Cookie thiếu sẽ được đặt lại.
 * Chưa có gì → cấp mã mới (chưa ghi gì vào kho cho tới khi người đó bắt đầu).
 */
export function identify(req, res) {
  const ck = parseCookies(req.headers.cookie);
  let code = codeFromToken(ck[PID_COOKIE]);
  if (!code) code = codeFromToken(req.headers['x-rec-pid']);
  const isNew = !code;
  if (!code) code = newCode();
  const token = tokenFor(code);
  if (ck[PID_COOKIE] !== token) setCookie(req, res, PID_COOKIE, token, { maxAge: 86400 * config.cookieDays });
  return { code, token, isNew };
}

/* =================================================== Bản ghi & trạng thái */

export const profilePath = (code) => `p/${code}/profile.json`;
export const recordingPath = (code, pos, item, restarts) =>
  `p/${code}/${String(pos).padStart(2, '0')}_${item}_r${restarts}.wav`;
const REC_RE = /^p\/(R[A-Z0-9]{7})\/(\d+)_([A-Za-z0-9]+)_r(\d+)\.wav$/;

export function parseRecording(f) {
  const m = REC_RE.exec(f.pathname);
  if (!m) return null;
  return {
    code: m[1], position: Number(m[2]), item_id: m[3], restarts: Number(m[4]),
    pathname: f.pathname, size: f.size, uploadedAt: new Date(f.uploadedAt),
  };
}

/**
 * Gom các file của 1 người: bản ghi mới nhất cho mỗi vị trí, cờ "bị loại", thời điểm hoạt động cuối.
 */
export function summarizeFiles(files) {
  const recs = new Map();
  let excluded = false, profile = null, last = null;
  for (const f of files) {
    if (f.pathname.endsWith('/_excluded')) excluded = true;
    if (f.pathname.endsWith('/profile.json')) profile = f;
    if (!last || new Date(f.uploadedAt) > last) last = new Date(f.uploadedAt);
    const r = parseRecording(f);
    if (!r) continue;
    const prev = recs.get(r.position);
    if (!prev || r.uploadedAt > prev.uploadedAt) recs.set(r.position, r);
  }
  return { recs, excluded, profileFile: profile, lastActivity: last };
}

/** Ước tính thời lượng WAV (PCM 16-bit mono) từ dung lượng. */
export const wavDurationMs = (size, rate) => (rate > 0 ? Math.max(0, (size - 44) / 2 / rate) * 1000 : null);

export function imageUrl(img) {
  return img && img.path ? `/api/participant?action=image&p=${encodeURIComponent(img.path)}` : null;
}

export async function loadImages() {
  const m = await getJson('cfg/images.json', { fresh: true }).catch(() => null);
  return (m && m.items) || {};
}

/** Trạng thái gửi cho trình duyệt người tham gia. */
export async function participantState(code, token) {
  const total = loadStimuli().length;
  const base = {
    ok: true, code, token, total, done: 0, done_positions: [], trials: [],
    sample_rate: config.sampleRate, max_seconds: config.maxSeconds, completion_url: config.completionUrl,
  };
  const profile = await getJson(profilePath(code));
  if (!profile) return { ...base, status: 'new' };

  const [files, images] = await Promise.all([listFiles(`p/${code}/`), loadImages()]);
  const { recs } = summarizeFiles(files);
  const order = profile.order || [];
  const donePos = [];
  const trials = [];
  order.forEach((itemId, i) => {
    const pos = i + 1;
    const r = recs.get(pos);
    if (r && r.item_id === itemId) { donePos.push(pos); return; }
    const s = stimulusById(itemId);
    if (!s) return;
    trials.push({ position: pos, item_id: itemId, sentence: s.sentence, image: imageUrl(images[itemId]) });
  });
  return {
    ...base,
    // đổi khi admin xoá bản ghi → trình duyệt bỏ các ghi nhớ "đã lưu" cũ
    epoch: `${profile.created_at || ''}:${profile.reset_count || 0}`,
    total: order.length,
    status: trials.length ? 'in_progress' : 'completed',
    done: donePos.length,
    done_positions: donePos,
    trials,
  };
}
