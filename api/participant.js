import { config, MAX_UPLOAD_BYTES } from '../lib/config.js';
import {
  parseUrl, readBody, readRaw, sendJson, postAllowed,
} from '../lib/http.js';
import {
  identify, participantState, profilePath, recordingPath, newOrder, loadStimuli,
} from '../lib/experiment.js';
import { getJson, putJson, putFile, getStream } from '../lib/store.js';

const IMG_RE = /^img\/[A-Za-z0-9]+-\d+\.(jpg|jpeg|png|webp|gif)$/;

/** Đọc thông số WAV: chỉ nhận PCM 16-bit mono. */
function wavInfo(buf) {
  if (buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, fmt = null, dataBytes = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      dataBytes = Math.min(size, buf.length - off - 8);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataBytes === null || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) return null;
  return { rate: fmt.rate, durationMs: Math.round((dataBytes / 2 / fmt.rate) * 1000) };
}

const clean = (v, n = 120) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  return s || null;
};

export default async function handler(req, res) {
  try {
    const url = parseUrl(req);
    const action = url.searchParams.get('action') || '';
    const isPost = req.method === 'POST';

    // Ảnh minh hoạ: công khai, đường dẫn có số phiên bản nên cache lâu được
    if (action === 'image') {
      const p = url.searchParams.get('p') || '';
      if (!IMG_RE.test(p)) return sendJson(res, 400, { ok: false });
      const r = await getStream(p);
      if (!r) return sendJson(res, 404, { ok: false });
      res.statusCode = 200;
      res.setHeader('Content-Type', r.contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (r.size) res.setHeader('Content-Length', r.size);
      return r.stream.pipe(res);
    }

    if (isPost && !postAllowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    const who = identify(req, res);

    switch (action) {
      case 'state':
        return sendJson(res, 200, await participantState(who.code, who.token));

      // Đồng ý tham gia + thông tin (tuỳ chọn) → tạo hồ sơ và thứ tự câu
      case 'begin': {
        if (!isPost) return sendJson(res, 405, { ok: false });
        const body = await readBody(req);
        if (body.consent !== true) return sendJson(res, 422, { ok: false, error: 'consent_required' });
        const existing = await getJson(profilePath(who.code));
        if (!existing) {
          let demo = null;
          if (body.demographics && typeof body.demographics === 'object') {
            const d = body.demographics;
            const age = /^\d{1,3}$/.test(String(d.age ?? '')) && Number(d.age) >= 1 && Number(d.age) <= 120 ? Number(d.age) : null;
            demo = { age, country: clean(d.country), state: clean(d.state), city: clean(d.city) };
            if (!demo.age && !demo.country && !demo.state && !demo.city) demo = null;
          }
          const order = newOrder();
          await putJson(profilePath(who.code), {
            code: who.code,
            created_at: new Date().toISOString(),
            order,
            order_mode: config.orderMode,
            order_seed: config.orderMode === 'fixed' ? config.orderSeed : null,
            demographics: demo,
            demo_status: demo ? 'filled' : 'skipped',
            device: body.device === 'mobile' ? 'mobile' : 'desktop',
            input: clean(body.input, 20),
            screen: clean(body.screen, 40),
            user_agent: clean(req.headers['user-agent'], 400),
            external_id: clean(body.external_id),
            total: loadStimuli().length,
          });
        }
        return sendJson(res, 200, await participantState(who.code, who.token));
      }

      // Bản ghi 1 câu (WAV thô trong body)
      case 'upload': {
        if (!isPost) return sendJson(res, 405, { ok: false });
        const pos = Number(url.searchParams.get('pos') || 0);
        const item = String(url.searchParams.get('item') || '');
        const restarts = Math.max(0, Math.min(999, Math.floor(Number(url.searchParams.get('restarts')) || 0)));
        const profile = await getJson(profilePath(who.code));
        if (!profile) return sendJson(res, 409, { ok: false, error: 'no_profile' });
        const order = profile.order || [];
        if (!Number.isInteger(pos) || pos < 1 || pos > order.length || order[pos - 1] !== item) {
          return sendJson(res, 409, { ok: false, error: 'bad_position' });
        }
        let buf;
        try {
          buf = await readRaw(req, MAX_UPLOAD_BYTES);
        } catch (e) {
          if (e.code === 'too_large') return sendJson(res, 413, { ok: false, error: 'too_large' });
          throw e;
        }
        const info = wavInfo(buf);
        if (!info) return sendJson(res, 422, { ok: false, error: 'bad_audio' });
        await putFile(recordingPath(who.code, pos, item, restarts), buf, 'audio/wav');
        return sendJson(res, 200, { ok: true, position: pos, duration_ms: info.durationMs, finished: pos === order.length });
      }

      default:
        return sendJson(res, 400, { ok: false, error: 'unknown_action' });
    }
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { ok: false, error: 'server', message: String(e.message || e).slice(0, 300) });
  }
}
