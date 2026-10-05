# Sổ Ghi Âm

Web thu âm chạy hoàn toàn trên trình duyệt: ghi từ micro, xem dạng sóng và mức vào (dBFS), nghe lại, đổi tên, tải file gốc hoặc WAV, chia sẻ sang ứng dụng khác trên điện thoại. Bản ghi lưu trong IndexedDB của trình duyệt, không gửi lên máy chủ.

Không có bước build, không cần `npm install`. Vercel phục vụ thẳng các file tĩnh.

## Cấu trúc

```
index.html              Trang chính
css/styles.css          Giao diện (sáng / tối theo hệ thống)
js/app.js               Ghi âm, đồng hồ mức, phát lại, danh sách bản ghi
js/format.js            Định dạng thời gian, dung lượng, dB, định dạng âm thanh
js/storage.js           Cài đặt (localStorage) và kho bản ghi (IndexedDB)
js/wav.js               Chuyển sang WAV 16-bit
sw.js                   Service worker: mở được khi mất mạng
manifest.webmanifest    Cài lên màn hình chính như app
icons/                  Biểu tượng app
vercel.json             Header bảo mật và quyền dùng micro
```

## Deploy lên Vercel

### Cách 1: qua GitHub (khuyên dùng)

```bash
cd so-ghi-am
git init
git add .
git commit -m "Sổ Ghi Âm"
git branch -M main
git remote add origin https://github.com/<tài-khoản>/so-ghi-am.git
git push -u origin main
```

Sau đó vào https://vercel.com/new, chọn repo vừa push, rồi:

- **Framework Preset:** Other
- **Build Command:** để trống
- **Output Directory:** để trống (thư mục gốc)

Bấm **Deploy**. Từ lần sau, mỗi lần `git push` Vercel tự deploy lại.

### Cách 2: dùng Vercel CLI

```bash
npm i -g vercel
cd so-ghi-am
vercel          # lần đầu: đăng nhập, tạo project, ra link preview
vercel --prod   # đưa lên link chính
```

### Gắn tên miền riêng

Trong project trên Vercel: **Settings → Domains → Add**, nhập ví dụ `ghiam.tenmien.com`, rồi tạo bản ghi CNAME trỏ về `cname.vercel-dns.com` như Vercel hướng dẫn. Vercel tự cấp HTTPS.

## Chạy thử trên máy

Trình duyệt chỉ cho dùng micro trên HTTPS hoặc `localhost`, và file mở trực tiếp (`file://`) không tải được JS module, nên cần một server nhỏ:

```bash
cd so-ghi-am
npx serve .        # mở http://localhost:3000
```

Muốn chạy với đúng các header trong `vercel.json` thì dùng `vercel dev`.

## Lưu ý

- **Định dạng:** Chrome, Edge, Firefox ghi WebM/Opus; Safari (iPhone, Mac) ghi M4A/AAC. Nút "Tải .wav" chuyển sang WAV để mở được ở mọi phần mềm.
- **iPhone:** khi khóa màn hình hoặc chuyển app, Safari sẽ ngắt micro. Trang tự giữ màn hình sáng trong lúc ghi để tránh việc này.
- **Dữ liệu:** bản ghi gắn với trình duyệt và tên miền. Xóa dữ liệu duyệt web hoặc đổi tên miền thì không còn thấy bản ghi cũ.
- **Cập nhật:** service worker ưu tiên tải bản mới từ mạng, nên deploy xong là người dùng thấy ngay bản mới. Nếu đổi danh sách file trong `sw.js`, tăng số phiên bản `CACHE` (ví dụ `so-ghi-am-v2`).
- **Content-Security-Policy** trong `vercel.json` chỉ cho phép script của chính trang và font của Google Fonts. Nếu thêm Vercel Analytics hay dịch vụ ngoài, nhớ bổ sung tên miền tương ứng vào CSP.
