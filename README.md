# tqk-git-sync (Sync2)

**Safe two-machine file sync without Git.** A small Electron app and CLI that packs only the source files you changed into a `.sync2pack`, scans them for secrets, and applies them on the other machine with a backup, a three-way comparison and conflict copies, so that nothing is ever silently overwritten. Packs can travel by USB / chat / cloud drive, or through an SFTP relay you configure yourself.

> Tiếng Việt bên dưới. Công cụ này do Truong Quang Khai viết cho nhu cầu làm việc giữa hai máy Windows (một máy có thể không có Git hoặc quyền admin).

---

## Tính năng chính
- **Không ghi đè mù quáng:** so khớp 3 bên (bản gốc, máy này, máy kia). File cả hai bên cùng sửa được giữ nguyên và bản của máy kia lưu thành `tên_file.conflict-<máy>-<thời_gian>.ext`.
- **Thư mục được bảo vệ (cấu hình được):** mặc định không động tới `data/crawl/**`, `storage/**`, `node_modules/**`, `dist/**` (xem `DEFAULT_PROTECT` trong `src/core/sync2-engine.js`).
- **Quét khoá bí mật** trước khi tạo gói: `github_pat_`, `ghp_`, `sk-`, `AIza`, file `.env`, khối private key…
- **Sao lưu trước khi nhận** vào `.sync2/backups/<timestamp>/`, có nút Hoàn tác.
- **Chống Zip-Slip**, kiểm tra **SHA-256**, ghi nguyên tử (ghi tệp tạm rồi đổi tên).
- Chế độ **dry-run** mặc định: luôn xem được danh sách file trước khi làm thật.

## Cách dùng nhanh
1. Chạy `npm install` rồi `npm start` (hoặc dựng bản portable bằng `npm run dist`).
2. Bấm **Chọn thư mục** và trỏ tới thư mục dự án.
3. Bấm **Kiểm tra** để xem file đã đổi.
4. Máy A: **Gửi sang máy kia** để tạo `.sync2pack`. Máy B: **Nhận về** và chọn file đó.
5. File hai bên cùng sửa sẽ thành bản `.conflict-…`; bản của máy này luôn được giữ.

### Trao đổi qua SFTP (tuỳ chọn)
Cấu hình trong `.sync2/config.json` của dự án (hoặc biến môi trường `SYNC2_SFTP_HOST`, `SYNC2_SFTP_USER`, `SYNC2_SFTP_KEY`, `SYNC2_SFTP_PORT`):
```json
{ "transport": "sftp", "sftp": { "host": "your.server", "port": 22, "username": "user", "privateKeyPath": "C:\\path\\to\\key" } }
```
Không có địa chỉ máy chủ, tên đăng nhập hay khoá mặc định: phải tự đặt. Khoá riêng không bao giờ được ghi vào gói hoặc nhật ký.

## Dòng lệnh (CLI)
```bash
node src/cli.js status --project <thư-mục-dự-án>
node src/cli.js pack   --project <thư-mục-dự-án> --dry-run
node src/cli.js pack   --project <thư-mục-dự-án> --out update.sync2pack
node src/cli.js unpack update.sync2pack --project <thư-mục-dự-án>
node src/cli.js undo   --project <thư-mục-dự-án>
```

## Kiểm thử
```bash
node --test tests/suite.test.js
```
Test số 10 chạy thử trên một dự án thật chỉ-đọc và **bị bỏ qua** trừ khi đặt biến `SYNC2_REAL_PROJECT=<thư-mục-dự-án>`.

## Giới hạn đã biết
- Chỉ kiểm thử trên Windows. Chưa kiểm thử tải/gửi qua SFTP với máy chủ thật trong repo này (cần máy chủ của bạn).
- Bộ quét khoá bí mật dựa trên mẫu (regex) nên có thể báo nhầm với file không phải mã nguồn (ví dụ trang web lưu về chứa mã đo lường). Khi đó gói bị chặn và bạn phải loại file đó ra.
- Danh sách thư mục được bảo vệ mặc định mang tính ví dụ; hãy chỉnh theo dự án của bạn.

## Giấy phép
MIT. Xem `LICENSE`.
