#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { Sync2Engine } = require('./core/sync2-engine');
const { SftpTransport } = require('./core/sftp-transport');

const engine = new Sync2Engine();

function parseArgs(args) {
  const parsed = {
    command: args[0] || 'help',
    project: process.cwd(),
    out: null,
    pack: null,
    from: null,
    dryRun: false,
    allowLarge: false
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project' && args[i + 1]) {
      parsed.project = path.resolve(args[++i]);
    } else if (arg === '--out' && args[i + 1]) {
      parsed.out = path.resolve(args[++i]);
    } else if (arg === '--from' && args[i + 1]) {
      parsed.from = args[++i];
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--allow-large') {
      parsed.allowLarge = true;
    } else if (!arg.startsWith('--') && !parsed.pack) {
      parsed.pack = path.resolve(arg);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`
================================================================================
  SYNC2: ỨNG DỤNG TRAO ĐỔI & ĐỒNG BỘ FILE AN TOÀN (KHÔNG DÙNG GIT)
================================================================================

Cách dùng:
  node src/cli.js <lệnh> [tuỳ chọn]

Các lệnh chính:
  status               Kiểm tra trạng thái file thay đổi so với lần đồng bộ trước
  pack                 Tạo gói trao đổi (.sync2pack) chứa các file đã sửa/mới
  unpack <file.pack>   Nhận và áp dụng gói trao đổi vào thư mục dự án
  undo                 Hoàn tác lần nhận gói gần nhất từ thư mục sao lưu
  upload               Tạo gói và đẩy lên trạm trung gian SFTP đã cấu hình
  download             Tải gói mới nhất từ máy kia trên trạm SFTP về và áp dụng
  sync                 Đồng bộ 2 chiều qua trạm SFTP (tải về trước, đẩy lên sau)

Tuỳ chọn:
  --project <đường dẫn>  Chỉ định thư mục dự án (mặc định: thư mục hiện tại)
  --out <đường dẫn>      Chỉ định tên file .sync2pack xuất ra
  --from <tên máy>       Chỉ định tên máy nguồn khi tải từ trạm SFTP
  --dry-run              Chế độ mô phỏng thử nghiệm (không ghi/đổi file thật)
  --allow-large          Cho phép gửi file vượt 50MB (mặc định bị chặn)
  `);
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  try {
    switch (options.command) {
      case 'status': {
        console.log(`\n--- KIỂM TRA TRẠNG THÁI: ${options.project} ---`);
        const st = await engine.getStatus(options.project);
        console.log(`• Dự án: ${st.projectId} | Tên máy này: ${st.machineName}`);
        console.log(`• Lần đồng bộ trước: ${st.lastSyncedAt || '(Chưa có - lần đầu)'}`);
        console.log(`• Tổng số file theo dõi: ${st.totalTrackedFiles} file`);
        console.log(`\nChi tiết thay đổi:`);
        console.log(`  - File đã sửa (${st.comparison.modified.length}):`);
        st.comparison.modified.forEach(f => console.log(`      * [SỬA] ${f.path}`));
        console.log(`  - File thêm mới (${st.comparison.added.length}):`);
        st.comparison.added.forEach(f => console.log(`      + [MỚI] ${f.path}`));
        console.log(`  - File đã xoá (${st.comparison.deleted.length}):`);
        st.comparison.deleted.forEach(f => console.log(`      - [XOÁ] ${f.path}`));
        console.log(`\n=> ${st.explanation}\n`);
        break;
      }

      case 'pack': {
        console.log(`\n--- TẠO GÓI TRAO ĐỔI (.sync2pack) ---`);
        if (options.dryRun) console.log(`[CHẾ ĐỘ MÔ PHỎNG DRY-RUN ĐANG BẬT]`);
        const res = await engine.createExchangePack(options.project, {
          outputPackPath: options.out,
          dryRun: options.dryRun,
          allowLargeFiles: options.allowLarge
        });

        if (res.nothingToPack) {
          console.log(`\n[THÔNG BÁO] ${res.message}\n`);
        } else if (res.dryRun) {
          console.log(`\n[KẾ HOẠCH SẼ LÀM GÌ]:`);
          console.log(`• Dự kiến lưu tại: ${res.plan.targetPackPath}`);
          console.log(`• Tổng số file: ${res.plan.totalFiles} file (${res.plan.totalSizeMb})`);
          res.plan.files.forEach(f => console.log(`  [${f.status.toUpperCase()}] ${f.path}`));
          console.log(`\n=> Bỏ cờ --dry-run để thực hiện tạo gói thật.\n`);
        } else {
          console.log(`\n[THÀNH CÔNG] ${res.message}`);
          console.log(`• Đường dẫn file: ${res.packPath}`);
          console.log(`• SHA256 Checksum: ${res.packSha256}\n`);
        }
        break;
      }

      case 'unpack': {
        if (!options.pack) {
          console.error(`Lỗi: Vui lòng chỉ định đường dẫn file .sync2pack cần nhận!`);
          console.log(`Ví dụ: node src/cli.js unpack E:\\updates.sync2pack`);
          process.exit(1);
        }

        console.log(`\n--- NHẬN VÀ ÁP DỤNG GÓI TRAO ĐỔI ---`);
        if (options.dryRun) console.log(`[CHẾ ĐỘ MÔ PHỎNG DRY-RUN ĐANG BẬT]`);

        const res = await engine.receiveExchangePack(options.project, options.pack, {
          dryRun: options.dryRun
        });

        if (res.dryRun) {
          console.log(`\n[KẾ HOẠCH SẼ LÀM GÌ]:`);
          console.log(`• Gói gửi từ máy: ${res.fromMachine}`);
          console.log(`• Sẽ cập nhật an toàn: ${res.plan.safeUpdates.length} file`);
          res.plan.safeUpdates.forEach(f => console.log(`    * [CẬP NHẬT] ${f.path}`));
          console.log(`• Sẽ tạo mới an toàn: ${res.plan.safeCreates.length} file`);
          res.plan.safeCreates.forEach(f => console.log(`    + [TẠO MỚI] ${f.path}`));
          console.log(`• Xung đột (lưu song song): ${res.plan.conflicts.length} file`);
          res.plan.conflicts.forEach(f => console.log(`    ! [XUNG ĐỘT] ${f.path} => sẽ lưu thành: ${f.conflictSavePath}`));
          console.log(`• Bỏ qua vì bảo vệ (protect): ${res.plan.rejectedProtected.length} file`);
          res.plan.rejectedProtected.forEach(f => console.log(`    # [BẢO VỆ] ${f.path}`));
          console.log(`\n=> ${res.message}\n`);
        } else {
          console.log(`\n[THÀNH CÔNG] ${res.message}`);
          if (res.backupId) console.log(`• Đã sao lưu bản cũ tại: .sync2/backups/${res.backupId}`);
          if (res.conflictFilesCreated && res.conflictFilesCreated.length > 0) {
            console.log(`\n[CẢNH BÁO XUNG ĐỘT] Danh sách file được lưu song song:`);
            res.conflictFilesCreated.forEach(c => console.log(`  ! Gốc: ${c.original} => File máy kia: ${c.conflictFile}`));
          }
          console.log('');
        }
        break;
      }

      case 'undo': {
        console.log(`\n--- HOÀN TÁC LẦN NHẬN GẦN NHẤT ---`);
        const res = await engine.undoLatestReceive(options.project);
        console.log(`\n[THÀNH CÔNG] Đã hoàn tác ${res.restoredFilesCount} file về ảnh chụp: ${res.backupId}\n`);
        break;
      }

      case 'upload': {
        console.log(`\n--- ĐẨY GÓI LÊN TRẠM SFTP (VM Cloud) ---`);
        const config = engine.loadProjectConfig(options.project);
        const sftp = new SftpTransport({
          host: config.sftp.host,
          port: config.sftp.port,
          username: config.sftp.username,
          privateKeyPath: config.sftp.privateKeyPath,
          logger: engine.logger
        });

        // 1. Tạo gói tạm
        const tempPackPath = path.join(options.project, '.sync2', `temp_upload_${Date.now()}.sync2pack`);
        const packRes = await engine.createExchangePack(options.project, {
          outputPackPath: tempPackPath,
          allowLargeFiles: options.allowLarge
        });

        if (packRes.nothingToPack) {
          console.log(`\n[THÔNG BÁO] Không có thay đổi nào để đẩy lên trạm.\n`);
          return;
        }

        // 2. Upload
        const upRes = await sftp.uploadPack(tempPackPath, config.projectId, config.machineName);
        console.log(`\n[THÀNH CÔNG] Đã đẩy gói lên trạm SFTP thành công: ${upRes.remoteFilePath}\n`);

        // Dọn file tạm
        try { fs.unlinkSync(tempPackPath); } catch {}
        break;
      }

      case 'download': {
        console.log(`\n--- TẢI GÓI TỪ TRẠM SFTP (VM Cloud) ---`);
        const config = engine.loadProjectConfig(options.project);
        const otherMachine = options.from || (config.machineName === 'May-A' ? 'May-B' : 'May-A');
        const sftp = new SftpTransport({
          host: config.sftp.host,
          port: config.sftp.port,
          username: config.sftp.username,
          privateKeyPath: config.sftp.privateKeyPath,
          logger: engine.logger
        });

        const localSavePath = path.join(options.project, '.sync2', `download_${otherMachine}.sync2pack`);
        await sftp.downloadLatestPack(config.projectId, otherMachine, localSavePath);
        console.log(`Đã tải xong gói của máy "${otherMachine}". Bắt đầu áp dụng...`);

        const res = await engine.receiveExchangePack(options.project, localSavePath, { dryRun: options.dryRun });
        console.log(`\n[THÀNH CÔNG] ${res.message}\n`);
        break;
      }

      case 'help':
      default:
        printHelp();
        break;
    }
  } catch (err) {
    console.error(`\n[LỖI]: ${err.message}\n`);
    process.exit(1);
  }
}

main();
