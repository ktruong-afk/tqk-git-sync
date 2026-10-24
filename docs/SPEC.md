# SPEC: Ứng dụng Trao đổi & Đồng bộ File Giữa 2 Máy ("Sync2") — Không dùng Git

## 1. MỤC TIÊU & PHẠM VI DỰ ÁN
- **Mục tiêu**: Đồng bộ 2 chiều mã nguồn & tài liệu giữa máy chính (máy nhà) và máy phụ ("máy net", quán net, không quyền admin, không cài git, sau NAT).
- **Nguyên tắc cốt lõi**:
  - **KHÔNG dùng Git, KHÔNG dùng GitHub**.
  - Cơ chế đồng bộ file dựa trên **Bản kê (Manifest) + So khớp 3 bên (Three-way merge)** dựa vào `base.json`.
  - **An toàn tuyệt đối**:
    + Không bao giờ ghi đè hoặc xóa thư mục dữ liệu cấm (`protect`: `data/crawl`, `data/game`, `storage`, `node_modules`, `dist`, v.v.).
    + Chặn triệt để mã khóa bí mật, token (regex scan) và file > 50MB.
    + Khi có xung đột: Không ghi đè mất dữ liệu. Giữ cả hai: bản đến lưu thành `<filename>.conflict-<machine>-<time>.<ext>`.
    + Chống Zip-Slip (từ chối `..` và đường dẫn tuyệt đối).
    + Ghi an toàn Atomic (ghi file tạm `.tmp` rồi đổi tên, kiểm tra SHA256 sau ghi).
    + Sao lưu trước khi nhận gói vào `.sync2/backups/<timestamp>/` có nút hoàn tác 1 click.
  - **Phương thức vận chuyển (Transport Layers)**:
    1. **Gói trao đổi `.sync2pack` (Ưu tiên số 1 - Offline/USB/Zalo/Cloud Drive)**: Nén zip file thay đổi + manifest + SHA256 checksum.
    2. **Trạm trung gian SFTP (VM Cloud)**: Kết nối tới VM `<sftp-host>` qua SFTP (chỉ kết nối chiều ra ngoài, lưu gói vào `/srv/sync2/<projectId>/`).
    3. **LAN Direct HTTP**: Kết nối nội mạng bằng mã PIN 6 số.

---

## 2. KIẾN TRÚC KỸ THUẬT & DỮ LIỆU

### 2.1. Cấu trúc thư mục `.sync2/` trong mỗi dự án
```
<project_root>/
├── .sync2/
│   ├── config.json       # { projectId, machineName, protect: [], exclude: [], transport: "pack" }
│   ├── base.json         # Bản kê lần đồng bộ thành công gần nhất: { timestamp, files: { [relPath]: { size, sha256, mtime } } }
│   ├── backups/          # Thư mục chứa các ảnh chụp backup trước khi nhận gói
│   │   └── 2026-10-23_02-30-00/
│   │       ├── manifest.json
│   │       └── files/
│   └── sync2.log         # Nhật ký thao tác (lọc sạch token)
```

### 2.2. Định dạng Gói Trao đổi `.sync2pack`
Một file zip chứa:
- `sync2_manifest.json`:
  ```json
  {
    "format": "sync2pack",
    "version": "1.0",
    "projectId": "my-project-xyz",
    "fromMachine": "May-Nha",
    "createdAt": "2026-10-23T02:30:00.000Z",
    "files": [
      { "path": "app/main.js", "size": 1204, "sha256": "abc...", "status": "modified" },
      { "path": "docs/guide.md", "status": "deleted" }
    ],
    "checksum": "sha256_of_payload"
  }
  ```
- Thư mục `payload/`: Chứa nội dung thực tế của các file mới/sửa (đường dẫn tương đối an toàn, chuẩn hóa `/`).

### 2.3. Thuật toán So khớp 3 bên (Three-way Comparison)
Đối với mỗi file:
- `base`: trạng thái trong `base.json` (lần đồng bộ thành công gần nhất).
- `local`: trạng thái quét hiện tại trên máy nhận.
- `incoming`: trạng thái trong gói / từ máy kia.

| Tình huống | Base | Local | Incoming | Hành động an toàn |
|---|---|---|---|---|
| **Chỉ máy kia sửa** | V1 | V1 (chưa sửa) | V2 | Áp dụng V2 (Cập nhật an toàn) |
| **Chỉ máy này sửa** | V1 | V2 | V1 (chưa sửa) | Giữ nguyên V2 máy này (Bỏ qua) |
| **Cả 2 cùng sửa giống nhau** | V1 | V2 | V2 | Đã trùng khớp, cập nhật base |
| **Cả 2 cùng sửa khác nhau (XUNG ĐỘT)** | V1 | V2 | V3 | **XUNG ĐỘT**: Giữ V2 của máy này, ghi V3 thành `file.conflict-<machine>-<time>.ext`, báo cáo cho user |
| **Máy kia tạo file mới** | Không có | Không có | Có | Tạo mới file |
| **Cả 2 cùng tạo mới khác nhau** | Không có | V1 | V2 | **XUNG ĐỘT**: Giữ V1, lưu V2 thành file conflict |
| **Máy kia xoá file** | Có | Có (chưa sửa) | Xoá | Đánh dấu đề xuất xoá, hỏi xác nhận (không tự xoá cứng) |

---

## 3. CHECKLIST TIẾN ĐỘ THỰC HIỆN

- [x] **Mục 1**: Tạo cấu trúc module Core mới (Không Git):
  - [x] 1.1: `manifest-builder.js`: Quét thư mục, tính SHA256, so sánh base.json, kiểm tra protect/exclude.
  - [x] 1.2: `secret-scanner.js`: Quét token, regex API keys, file > 50MB, .env, storage/**.
  - [x] 1.3: `pack-manager.js`: Tạo & giải nén file `.sync2pack` (chống zip-slip, atomic rename, checksum).
  - [x] 1.4: `three-way-sync.js`: Thuật toán so khớp 3 bên, xử lý xung đột, tạo file `.conflict-...`.
  - [x] 1.5: `backup-manager.js`: Sao lưu trước khi nhận gói và hoàn tác.
  - [x] 1.6: `sftp-transport.js`: Module chuyển giao qua trạm trung gian VM `<sftp-host>` (kết nối ra ngoài).
- [x] **Mục 2**: Bộ kiểm thử tự động (Automated Test Suite):
  - [x] 2.1: A sửa, B không -> B nhận gói đúng.
  - [x] 2.2: Cả 2 cùng sửa -> giữ cả 2 (conflict file), không mất dữ liệu.
  - [x] 2.3: File trong `protect` có hash không đổi dù gói cố tình chứa file trùng đường dẫn.
  - [x] 2.4: Gói có token giả bị chặn khi gửi/tạo gói.
  - [x] 2.5: Gói có đường dẫn `..\x` (zip-slip) bị từ chối lập tức.
  - [x] 2.6: File > 50MB bị chặn.
  - [x] 2.7: Gói hỏng checksum bị từ chối.
  - [x] 2.8: Hoàn tác lần nhận phục hồi file cũ.
  - [x] 2.9: Nhận hai lần cùng 1 gói không làm gì thêm (idempotent).
  - [x] 2.10: Kiểm thử Thật CHỈ ĐỌC trên `<project>`: status và dry-run tạo gói liệt kê đúng mã nguồn, KHÔNG chạm vào data/crawl, storage.
- [x] **Mục 3**: Giao diện dòng lệnh CLI (`sync2 status|pack|unpack|sync`).
- [x] **Mục 4**: Giao diện đồ họa Electron (GUI tiếng Việt, nút to, theme Sáng/Tối, 3 lựa chọn xung đột, khung "Sẽ làm gì").
- [x] **Mục 5**: Build file Portable Windows & Hướng dẫn sử dụng.
