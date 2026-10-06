/**
 * Chuyển stimuli.csv → lib/stimuli.js (để danh sách câu được đóng gói cùng function).
 * Vercel tự chạy script này mỗi lần deploy (buildCommand trong vercel.json).
 * Chạy tay: npm run build
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const csv = fs.readFileSync(path.join(root, 'stimuli.csv'), 'utf8');
const out = `// TỰ SINH từ stimuli.csv — đừng sửa file này, hãy sửa stimuli.csv\nexport default ${JSON.stringify(csv)};\n`;
fs.writeFileSync(path.join(root, 'lib', 'stimuli.js'), out);
const lines = csv.split(/\r?\n/).filter((l) => l.trim()).length - 1;
console.log(`stimuli.csv → lib/stimuli.js (${lines} câu)`);
