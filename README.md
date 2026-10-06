# Thí nghiệm đọc to (Recording experiment)

Người tham gia đọc to 21 câu tiếng Anh, từng câu một, và mỗi câu được ghi âm rồi tự lưu lên máy chủ. Trang admin dùng để quản lý người tham gia, nghe bản ghi và phân tích cao độ (F0) cùng độ lớn (intensity).

- **Trang người tham gia:** `https://<project>.vercel.app/` (tiếng Anh)
- **Trang admin:** `https://<project>.vercel.app/admin` (tiếng Việt, đăng nhập bằng `ADMIN_PASSWORD`)

## Cách hoạt động

**Nhận diện người tham gia** giống thí nghiệm đọc (SPR). Lần đầu vào trang, mỗi người được cấp một mã như `R7KX2M9Q`. Mã được lưu trong cookie 1 năm (có chữ ký, không giả được), và có thêm bản dự phòng trong localStorage phòng khi cookie bị xoá. Mở lại link trên cùng trình duyệt là làm tiếp đúng câu chưa lưu.

**Quy trình của người tham gia:**
1. Đọc giới thiệu và tích ô đồng ý ghi âm.
2. Điền thông tin (tuổi, quốc gia, bang, thành phố). Bước này tuỳ chọn, có thể bỏ qua.
3. Kiểm tra micro: phải nghe thấy tiếng mới cho đi tiếp.
4. Xem hướng dẫn.
5. Đọc từng câu: bấm **Record**, đọc, bấm **Stop & save**. Bản ghi được lưu và câu tiếp theo trượt vào. Bấm **Restart** nếu đọc vấp. Thanh ghi âm luôn ghim ở đáy màn hình. Trên máy tính có thể dùng phím `Space`.
6. Hoàn thành: hiện mã. Nếu đặt `COMPLETION_URL` thì có thêm nút quay về nền tảng tuyển người.

Người tham gia không nghe lại được bản ghi của mình. Nếu bản ghi quá ngắn (< 0,7 giây) hoặc gần như im lặng, trang sẽ hỏi họ ghi lại hay vẫn lưu.

**Thứ tự câu** đúng requirement: hai câu cùng nhóm không đứng liền nhau, riêng nhóm baseline tối đa 2 câu liền nhau. Mặc định mọi người dùng chung một danh sách cố định (xem ở `/admin?view=order`). Đặt `ORDER_MODE=random` nếu muốn mỗi người một thứ tự riêng, vẫn giữ ràng buộc.

**Bản ghi** là WAV PCM 16-bit mono 44,1 kHz. Trình duyệt được yêu cầu tắt lọc ồn, khử tiếng vọng và tự cân âm lượng để giữ nguyên cao độ và độ lớn thật. Mỗi bản ghi giữ thêm 0,25 giây trước khi bấm Record và 0,35 giây sau khi bấm Stop để không mất âm đầu và âm cuối. Trang ghi tối đa 40 giây mỗi câu.

## Trang admin

- **Tổng quan:** số người hoàn thành, đang làm, bỏ dở và đã loại, dung lượng đã dùng, cùng danh sách người tham gia.
- **Từng người:** thông tin, thiết bị và 21 bản ghi. Mỗi bản ghi có biểu đồ cao độ và độ lớn. Bấm vào biểu đồ để nghe từ điểm đó. Kéo chuột để chọn một đoạn, ví dụ từ *totally*, rồi xem F0 và dB riêng của đoạn đó. Các nút thao tác: tải ZIP, loại khỏi phân tích, xoá bản ghi (người đó làm lại từ câu 1), xoá người.
- **Câu & ảnh:** danh sách câu, số bản ghi của từng câu, và chỗ tải ảnh minh hoạ lên (ảnh hiện phía trên câu khi người tham gia đọc). Bấm vào một câu để nghe bản ghi của mọi người và xem các đường cao độ chồng lên nhau, chuẩn hoá theo thời gian.
- **Xuất dữ liệu:** CSV kèm phân tích (F0 trung bình, trung vị, thấp, cao, độ lệch chuẩn, biên độ theo semitone, độ lớn trung bình và cao nhất, thời điểm bắt đầu và kết thúc lời nói), CSV danh sách bản ghi, CSV người tham gia, và ZIP toàn bộ file WAV.

**Phân tích chạy ngay trong trình duyệt của admin**, có lưu đệm nên lần sau mở nhanh hơn.
- Cao độ dùng thuật toán YIN: khung 40 ms, bước 10 ms, dải 60–600 Hz. Khung quá nhỏ tiếng bị bỏ qua và lỗi nhảy quãng tám được sửa.
- Độ lớn tính bằng dB cùng thang với Praat (biên độ 1 = 1 Pa), cửa sổ Hann 40 ms.
- Độ lớn tuyệt đối phụ thuộc micro và khoảng cách của từng người, nên chỉ nên so sánh trong cùng một người (ví dụ *totally* so với phần còn lại của câu).
- Muốn phân tích sâu hơn thì tải WAV về mở bằng Praat.

## Cấu trúc

```
public/                 giao diện người tham gia + file tĩnh của admin
  index.html
  assets/app.js         luồng làm bài, ghi âm, lưu
  assets/recorder-worklet.js
  assets/admin.js       nghe, biểu đồ, xuất CSV/ZIP, ảnh
  assets/analysis-worker.js   phân tích F0 / intensity
api/
  participant.js        trạng thái, bắt đầu, nhận bản ghi, ảnh minh hoạ
  admin.js              trang /admin
  health.js             /api/health: kiểm tra cấu hình
lib/                    cấu hình, lưu trữ, thứ tự câu, nhận diện
stimuli.csv             ★ danh sách câu (sửa bằng Excel, lưu CSV UTF-8)
vercel.json
```

## Lưu trữ

Mọi dữ liệu nằm trong **Vercel Blob** (store `recordingexperiment-audio`, chế độ private, region iad1), không cần database:

```
p/<MÃ>/profile.json            hồ sơ + thứ tự câu
p/<MÃ>/<vị trí>_<câu>_r<n>.wav  bản ghi (n = số lần ghi lại)
p/<MÃ>/_excluded               có file này = đã loại
cfg/images.json, img/…         ảnh minh hoạ
```

Gói Hobby miễn phí của Vercel Blob có giới hạn hằng tháng: 1 GB dung lượng và một số lượt thao tác nhất định. Mỗi người tham gia tốn khoảng 8–12 MB và khoảng 25 lượt ghi. Xem mức dùng ở Vercel → Storage. Khi gần hết, tải ZIP về rồi xoá bớt người đã xử lý, hoặc nâng gói.

## Biến môi trường

| Tên | Ý nghĩa |
|---|---|
| `ADMIN_PASSWORD` | mật khẩu trang admin (bắt buộc) |
| `SESSION_SECRET` | ký cookie. **Đừng đổi khi đang thu dữ liệu**, đổi là người đang làm dở mất phiên |
| `BLOB_READ_WRITE_TOKEN` | tự có khi gắn Blob store vào project |
| `ORDER_MODE` / `ORDER_SEED` | `fixed` (mặc định) hoặc `random`; đổi seed để ra danh sách cố định khác |
| `SAMPLE_RATE` | mặc định 44100 |
| `MAX_SECONDS` | thời lượng tối đa mỗi câu, mặc định 40 |
| `COMPLETION_URL` | link khi hoàn thành (vd. Prolific); `{code}` được thay bằng mã người tham gia |
| `CHECK_KEY` | dùng cho `/api/health?write=<CHECK_KEY>` để kiểm tra ghi/đọc kho |

Sau khi đổi biến môi trường, vào Deployments → Redeploy.

## Sửa danh sách câu

Sửa `stimuli.csv` (cột `item_id, group, group_label, sentence`), commit và push. Vercel tự build lại. Nhóm có `group` là `baseline` được phép 2 câu liền nhau. Người đã bắt đầu giữ nguyên thứ tự cũ của mình.

## Chạy thử trên máy

```bash
npm install
npm run dev          # http://localhost:3000, admin mật khẩu "admin", dữ liệu lưu trong .data/
```
