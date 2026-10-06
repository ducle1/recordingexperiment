/**
 * Chạy thử trên máy: npm run dev   (lưu dữ liệu vào thư mục .data, mật khẩu admin mặc định "admin")
 * Trên Vercel không dùng file này — Vercel tự phục vụ public/ và api/.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import participant from './api/participant.js';
import admin from './api/admin.js';
import health from './api/health.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/participant') return participant(req, res);
  if (pathname === '/api/admin' || pathname === '/admin') return admin(req, res);
  if (pathname === '/api/health') return health(req, res);
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  if (pathname === '/sw.js') res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT || 3000), () => console.log(`http://localhost:${process.env.PORT || 3000}`));
