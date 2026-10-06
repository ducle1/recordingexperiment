/**
 * CẤU HÌNH
 * Mỗi mục có giá trị mặc định ngay tại đây. Muốn đổi mà không sửa code: đặt biến môi trường
 * cùng tên trong Vercel → Project → Settings → Environment Variables, rồi Redeploy.
 */
import crypto from 'node:crypto';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  // BẮT BUỘC: mật khẩu trang /admin
  adminPassword: env.ADMIN_PASSWORD || '',

  // Chuỗi bí mật để ký cookie người tham gia và admin.
  // Đừng đổi khi thí nghiệm đang chạy: đổi là người đang làm dở mất phiên.
  sessionSecret: env.SESSION_SECRET
    || (env.BLOB_READ_WRITE_TOKEN ? crypto.createHash('sha256').update('rec:' + env.BLOB_READ_WRITE_TOKEN).digest('hex') : '')
    || 'dev-only-secret',

  // Nơi lưu dữ liệu. Trên Vercel: Blob store (tự có BLOB_READ_WRITE_TOKEN khi gắn store vào project).
  // Chạy thử trên máy: đặt LOCAL_STORE_DIR=./.data để lưu vào thư mục.
  localStoreDir: env.LOCAL_STORE_DIR || '',

  // Thứ tự câu:
  //  'fixed'  (mặc định) = mọi người đọc cùng 1 danh sách (sinh theo ORDER_SEED)
  //  'random' = mỗi người 1 thứ tự riêng (vẫn đúng ràng buộc nhóm)
  orderMode: env.ORDER_MODE === 'random' ? 'random' : 'fixed',
  orderSeed: env.ORDER_SEED || 'rec-order-1',

  // Ràng buộc trong file requirement: nhóm baseline tối đa 2 câu liền nhau, các nhóm khác không liền nhau
  baselineGroup: 'baseline',
  baselineMaxRun: num(env.BASELINE_MAX_RUN, 2),
  otherMaxRun: num(env.OTHER_MAX_RUN, 1),

  // Ghi âm: tần số lấy mẫu của file WAV lưu lại (Hz) và thời lượng tối đa mỗi câu (giây)
  sampleRate: num(env.SAMPLE_RATE, 44100),
  maxSeconds: num(env.MAX_SECONDS, 40),

  // Không hoạt động quá N phút → coi là bỏ dở
  abandonMinutes: num(env.ABANDON_MINUTES, 30),

  // Link chuyển về khi hoàn thành (vd. Prolific). Để trống = chỉ hiện mã.
  completionUrl: env.COMPLETION_URL || '',

  // Múi giờ hiển thị trong trang admin
  timezone: env.TIMEZONE || 'Asia/Ho_Chi_Minh',

  // Thời hạn cookie nhận diện người tham gia (ngày)
  cookieDays: num(env.COOKIE_DAYS, 365),

  // Khoá cho /api/health?write=1 (kiểm tra ghi/đọc kho lưu trữ). Để trống = tắt kiểm tra ghi.
  checkKey: env.CHECK_KEY || '',
};

// Giới hạn body của Vercel Functions là 4.5 MB
export const MAX_UPLOAD_BYTES = 4_400_000;
