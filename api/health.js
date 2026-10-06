/**
 * Kiểm tra cấu hình: /api/health
 * Kiểm tra ghi/đọc/xoá thật trên kho lưu trữ: /api/health?write=<CHECK_KEY>
 */
import { config } from '../lib/config.js';
import { parseUrl, sendJson, safeEqual } from '../lib/http.js';
import { loadStimuli, fixedOrder, orderViolations } from '../lib/experiment.js';
import { store, putFile, getStream, listFiles, delFiles, streamToBuffer } from '../lib/store.js';

export default async function handler(req, res) {
  const out = {
    ok: true,
    admin_password_set: !!config.adminPassword,
    session_secret_set: !!process.env.SESSION_SECRET,
    blob_env: Object.keys(process.env).filter((k) => /BLOB/i.test(k)),
    sentences: loadStimuli().length,
    order_mode: config.orderMode,
    order_valid: !orderViolations(fixedOrder()).length,
  };
  try {
    out.store = store().kind;
  } catch (e) {
    out.ok = false;
    out.store_error = e.message;
    return sendJson(res, 500, out);
  }
  const key = parseUrl(req).searchParams.get('write');
  if (key && config.checkKey && safeEqual(key, config.checkKey)) {
    const t0 = Date.now();
    const p = `health/check-${t0}.txt`;
    try {
      await putFile(p, Buffer.from('ok ' + t0), 'text/plain');
      const r = await getStream(p, { fresh: true });
      const body = r ? (await streamToBuffer(r.stream)).toString() : null;
      const listed = (await listFiles('health/')).some((f) => f.pathname === p);
      await delFiles([p]);
      out.write_test = { put: true, read_back: body === 'ok ' + t0, listed, deleted: true, ms: Date.now() - t0 };
      out.ok = out.write_test.read_back && listed;
    } catch (e) {
      out.ok = false;
      out.write_test = { error: String(e.message || e).slice(0, 300) };
    }
  }
  return sendJson(res, out.ok ? 200 : 500, out);
}
