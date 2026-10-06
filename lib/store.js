/**
 * Kho lưu trữ file: Vercel Blob (khi chạy trên Vercel) hoặc thư mục trên máy (chạy thử).
 *
 * Cấu trúc:
 *   p/<MÃ>/profile.json              thông tin người tham gia + thứ tự câu
 *   p/<MÃ>/<vị trí>_<câu>_r<n>.wav   bản ghi từng câu (n = số lần bấm Restart)
 *   p/<MÃ>/_excluded                 có file này = admin đã loại người này khỏi phân tích
 *   cfg/images.json                  danh sách ảnh minh hoạ
 *   img/<câu>-<phiên bản>.<đuôi>     ảnh minh hoạ của từng câu
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.js';

const TYPES = {
  '.wav': 'audio/wav', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain',
};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';

/* ------------------------------------------------------------ Vercel Blob */

let blobMod = null;
async function blob() {
  if (!blobMod) blobMod = await import('@vercel/blob');
  return blobMod;
}
const ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';

const vercelStore = {
  kind: 'vercel-blob',
  async put(pathname, body, contentType) {
    const { put } = await blob();
    const r = await put(pathname, body, {
      access: ACCESS, addRandomSuffix: false, allowOverwrite: true,
      contentType: contentType || typeOf(pathname), cacheControlMaxAge: 60,
    });
    return { pathname: r.pathname, size: body.length, uploadedAt: new Date() };
  },
  async getStream(pathname, { fresh = false } = {}) {
    const { get } = await blob();
    const r = await get(pathname, { access: ACCESS, useCache: !fresh }).catch((e) => {
      if (e && /not.?found/i.test(String(e.name) + String(e.message))) return null;
      throw e;
    });
    if (!r || r.statusCode !== 200) return null;
    return {
      stream: Readable.fromWeb(r.stream),
      contentType: r.blob.contentType || typeOf(pathname),
      size: r.blob.size,
      uploadedAt: new Date(r.blob.uploadedAt),
      etag: r.blob.etag,
    };
  },
  async list(prefix) {
    const { list } = await blob();
    const out = [];
    let cursor;
    do {
      const r = await list({ prefix, cursor, limit: 1000 });
      for (const b of r.blobs) out.push({ pathname: b.pathname, size: b.size, uploadedAt: new Date(b.uploadedAt) });
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out;
  },
  async del(pathnames) {
    if (!pathnames.length) return;
    const { del } = await blob();
    for (let i = 0; i < pathnames.length; i += 500) await del(pathnames.slice(i, i + 500));
  },
};

/* ------------------------------------------------------- Thư mục local */

function localStore(dir) {
  const root = path.resolve(dir);
  const abs = (p) => {
    const f = path.resolve(root, p);
    if (!f.startsWith(root + path.sep)) throw new Error('bad path');
    return f;
  };
  async function walk(d, acc) {
    let entries = [];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return acc; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f, acc);
      else acc.push(f);
    }
    return acc;
  }
  return {
    kind: 'local-dir',
    async put(pathname, body) {
      const f = abs(pathname);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, body);
      return { pathname, size: body.length, uploadedAt: new Date() };
    },
    async getStream(pathname) {
      const f = abs(pathname);
      try {
        const st = await fs.stat(f);
        const { createReadStream } = await import('node:fs');
        return { stream: createReadStream(f), contentType: typeOf(f), size: st.size, uploadedAt: st.mtime, etag: String(st.mtimeMs) };
      } catch { return null; }
    },
    async list(prefix) {
      const files = await walk(root, []);
      const out = [];
      for (const f of files) {
        const p = path.relative(root, f).split(path.sep).join('/');
        if (!p.startsWith(prefix)) continue;
        const st = await fs.stat(f);
        out.push({ pathname: p, size: st.size, uploadedAt: st.mtime });
      }
      return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
    },
    async del(pathnames) {
      for (const p of pathnames) await fs.rm(abs(p), { force: true });
    },
  };
}

/* ------------------------------------------------------------- API chung */

let impl = null;
export function store() {
  if (impl) return impl;
  if (config.localStoreDir) impl = localStore(config.localStoreDir);
  else if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) impl = vercelStore;
  else {
    const keys = Object.keys(process.env).filter((k) => /BLOB/i.test(k));
    throw new Error('Chưa có kho lưu trữ: gắn một Blob store vào project (Vercel → Storage), rồi Redeploy. '
      + `Biến BLOB hiện có: ${keys.join(', ') || '(không có)'}`);
  }
  return impl;
}

export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const ch of stream) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
  return Buffer.concat(chunks);
}

export async function getJson(pathname, { fresh = true } = {}) {
  const r = await store().getStream(pathname, { fresh });
  if (!r) return null;
  const buf = await streamToBuffer(r.stream);
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

export function putJson(pathname, data) {
  return store().put(pathname, Buffer.from(JSON.stringify(data), 'utf8'), 'application/json');
}

export const putFile = (pathname, body, type) => store().put(pathname, body, type);
export const getStream = (pathname, opts) => store().getStream(pathname, opts);
export const listFiles = (prefix) => store().list(prefix);
export const delFiles = (pathnames) => store().del(pathnames);
