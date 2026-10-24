const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const { Sync2Engine } = require('../src/core/sync2-engine');
const { PackManager } = require('../src/core/pack-manager');
const { calculateFileSha256 } = require('../src/core/manifest-builder');

function setupTestFolders() {
  const root = path.join(os.tmpdir(), `sync2-nongit-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  const machineADir = path.join(root, 'machine-a');
  const machineBDir = path.join(root, 'machine-b');
  const cloudDir = path.join(root, 'cloud-relay');

  fs.mkdirSync(machineADir, { recursive: true });
  fs.mkdirSync(machineBDir, { recursive: true });
  fs.mkdirSync(cloudDir, { recursive: true });

  // Tạo cấu trúc ban đầu giống nhau trên cả 2 máy
  const initApp = (dir) => {
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data', 'crawl'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'storage'), { recursive: true });

    fs.writeFileSync(path.join(dir, 'app', 'main.js'), 'console.log("version 1.0");\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Initial Documentation\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'data', 'crawl', 'matches.json'), '{"crawled": 12345}', 'utf8');
    fs.writeFileSync(path.join(dir, 'storage', 'auth.dat'), 'sensitive-local-storage-data', 'utf8');
  };

  initApp(machineADir);
  initApp(machineBDir);

  return {
    root,
    machineADir,
    machineBDir,
    cloudDir,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // bỏ qua nếu bị lock tạm thời
      }
    }
  };
}

test('Kiểm thử tổng thể Sync2 (Non-Git: 10 kịch bản bắt buộc)', async (t) => {
  const env = setupTestFolders();
  const engine = new Sync2Engine();
  const projectId = 'test-dota-project';

  // Khởi tạo cả 2 máy cùng projectId
  engine.initProject(env.machineADir, { projectId, machineName: 'May-A' });
  engine.initProject(env.machineBDir, { projectId, machineName: 'May-B' });

  let packPathFromA = null;

  await t.test('1. A sửa, B không -> B nhận đúng', async () => {
    // Máy A sửa app/main.js và thêm app/helper.js
    fs.writeFileSync(path.join(env.machineADir, 'app', 'main.js'), 'console.log("version 2.0 updated by A");\n', 'utf8');
    fs.writeFileSync(path.join(env.machineADir, 'app', 'helper.js'), 'module.exports = { ok: true };\n', 'utf8');

    // Kiểm tra status máy A
    const statusA = await engine.getStatus(env.machineADir);
    assert.strictEqual(statusA.comparison.modified.length, 1, 'Máy A phải thấy 1 file modified');
    assert.strictEqual(statusA.comparison.added.length, 1, 'Máy A phải thấy 1 file added');

    // Máy A tạo gói trao đổi
    packPathFromA = path.join(env.cloudDir, 'update_from_a.sync2pack');
    const packRes = await engine.createExchangePack(env.machineADir, { outputPackPath: packPathFromA });
    assert.strictEqual(packRes.success, true, 'Tạo gói từ máy A phải thành công');
    assert.strictEqual(fs.existsSync(packPathFromA), true, 'File .sync2pack phải tồn tại');

    // Máy B nhận gói
    const receiveRes = await engine.receiveExchangePack(env.machineBDir, packPathFromA);
    assert.strictEqual(receiveRes.success, true, 'Máy B nhận gói phải thành công');
    assert.strictEqual(receiveRes.appliedCount, 2, 'Máy B phải áp dụng đúng 2 file');

    // Kiểm tra nội dung trên máy B
    const bMain = fs.readFileSync(path.join(env.machineBDir, 'app', 'main.js'), 'utf8');
    assert.strictEqual(bMain, 'console.log("version 2.0 updated by A");\n', 'app/main.js trên máy B phải được cập nhật');
    assert.strictEqual(fs.existsSync(path.join(env.machineBDir, 'app', 'helper.js')), true, 'app/helper.js phải có trên máy B');
  });

  await t.test('2. Cả hai sửa cùng file -> Giữ cả hai (conflict file), không mất dữ liệu', async () => {
    // Máy A sửa README.md
    fs.writeFileSync(path.join(env.machineADir, 'README.md'), '# Edit from Machine A\n', 'utf8');
    const conflictPack = path.join(env.cloudDir, 'conflict_pack.sync2pack');
    await engine.createExchangePack(env.machineADir, { outputPackPath: conflictPack });

    // Máy B cũng sửa README.md theo cách riêng
    fs.writeFileSync(path.join(env.machineBDir, 'README.md'), '# Conflicting edit from Machine B\n', 'utf8');

    // Máy B nhận gói từ máy A
    const receiveRes = await engine.receiveExchangePack(env.machineBDir, conflictPack);
    assert.strictEqual(receiveRes.success, true);
    assert.strictEqual(receiveRes.conflictsCount, 1, 'Phải phát hiện 1 file xung đột');

    // Kiểm tra: README.md của máy B không bị đè mất
    const bReadme = fs.readFileSync(path.join(env.machineBDir, 'README.md'), 'utf8');
    assert.strictEqual(bReadme, '# Conflicting edit from Machine B\n', 'File của máy B phải được giữ nguyên');

    // Kiểm tra: File conflict được tạo ra song song
    const conflictCreated = receiveRes.conflictFilesCreated[0];
    assert.ok(conflictCreated, 'Phải có file conflict được tạo');
    assert.ok(fs.existsSync(path.join(env.machineBDir, conflictCreated.conflictFile)), 'File conflict phải tồn tại trên ổ đĩa');
    const conflictContent = fs.readFileSync(path.join(env.machineBDir, conflictCreated.conflictFile), 'utf8');
    assert.strictEqual(conflictContent, '# Edit from Machine A\n', 'File conflict phải chứa nội dung của máy A');
  });

  await t.test('3. File trong protect (data/crawl, storage) có hash không đổi, kể cả khi gói cố tình ghi vào đó', async () => {
    const file1 = path.join(env.machineBDir, 'data', 'crawl', 'matches.json');
    const file2 = path.join(env.machineBDir, 'storage', 'auth.dat');
    const hash1Before = calculateFileSha256(file1);
    const hash2Before = calculateFileSha256(file2);

    // Tạo một gói ác ý cố tình ghi đè vào data/crawl/matches.json
    const maliciousZip = new AdmZip();
    const badManifest = {
      format: 'sync2pack',
      version: '1.0',
      projectId,
      fromMachine: 'Attacker',
      createdAt: new Date().toISOString(),
      files: [
        { path: 'data/crawl/matches.json', sha256: 'fake', size: 10 }
      ]
    };
    const badManifestBuf = Buffer.from(JSON.stringify(badManifest), 'utf8');
    maliciousZip.addFile('sync2_manifest.json', badManifestBuf);
    maliciousZip.addFile('__checksum__.txt', Buffer.from(crypto.createHash('sha256').update(badManifestBuf).digest('hex'), 'utf8'));
    maliciousZip.addFile('payload/data/crawl/matches.json', Buffer.from('malicious overwrite crawl data'));

    const badPackPath = path.join(env.cloudDir, 'bad_pack.sync2pack');
    maliciousZip.writeZip(badPackPath);

    // Máy B nhận gói ác ý
    const receiveRes = await engine.receiveExchangePack(env.machineBDir, badPackPath);
    assert.strictEqual(receiveRes.rejectedProtectedCount, 1, 'Phải từ chối file nằm trong protect');

    const hash1After = calculateFileSha256(file1);
    const hash2After = calculateFileSha256(file2);
    assert.strictEqual(hash1Before, hash1After, 'File matches.json trong data/crawl tuyệt đối không bị đổi');
    assert.strictEqual(hash2Before, hash2After, 'File auth.dat trong storage tuyệt đối không bị đổi');
  });

  await t.test('4. Gói có token giả bị chặn khi gửi/tạo gói', async () => {
    const secretFile = path.join(env.machineADir, 'app', 'credentials.js');
    fs.writeFileSync(secretFile, 'const key = "github_pat_11AABBCCDDEEFFGGHHIIJJKKLLMMNN_1234567890";\n', 'utf8');

    let failed = false;
    try {
      await engine.createExchangePack(env.machineADir, { outputPackPath: path.join(env.cloudDir, 'token_leak.sync2pack') });
    } catch (err) {
      failed = true;
      assert.ok(err.message.includes('CHẶN TẠO GÓI VÌ BẢO MẬT'), 'Phải có thông báo chặn tạo gói');
    }
    assert.strictEqual(failed, true, 'Quá trình tạo gói phải bị chặn khi phát hiện token');

    // Dọn file
    fs.unlinkSync(secretFile);
  });

  await t.test('5. Gói có đường dẫn ..\\x (Zip-Slip) bị từ chối lập tức', async () => {
    const slipZip = new AdmZip();
    const manifest = {
      format: 'sync2pack',
      version: '1.0',
      projectId,
      fromMachine: 'Attacker',
      createdAt: new Date().toISOString(),
      files: [
        { path: '../malicious.txt', sha256: 'fake', size: 10 }
      ]
    };
    const manBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
    slipZip.addFile('sync2_manifest.json', manBuf);
    slipZip.addFile('__checksum__.txt', Buffer.from(crypto.createHash('sha256').update(manBuf).digest('hex'), 'utf8'));

    const slipPackPath = path.join(env.cloudDir, 'zip_slip.sync2pack');
    slipZip.writeZip(slipPackPath);

    let slipRejected = false;
    try {
      await engine.receiveExchangePack(env.machineBDir, slipPackPath);
    } catch (err) {
      slipRejected = true;
      assert.ok(err.message.includes('ZIP-SLIP'), 'Phải từ chối vì Zip-Slip');
    }
    assert.strictEqual(slipRejected, true, 'Gói zip-slip phải bị từ chối');
  });

  await t.test('6. File > 50MB bị chặn khi tạo gói', async () => {
    const bigFile = path.join(env.machineADir, 'app', 'dataset.bin');
    const size51MB = 51 * 1024 * 1024;
    const fd = fs.openSync(bigFile, 'w');
    fs.writeSync(fd, Buffer.from('x'), 0, 1, size51MB - 1);
    fs.closeSync(fd);

    let bigBlocked = false;
    try {
      await engine.createExchangePack(env.machineADir, { outputPackPath: path.join(env.cloudDir, 'big.sync2pack') });
    } catch (err) {
      bigBlocked = true;
      assert.ok(err.message.includes('FILE_TOO_LARGE'), 'Phải báo vi phạm kích thước lớn');
    }
    assert.strictEqual(bigBlocked, true, 'File > 50MB phải bị chặn');

    fs.unlinkSync(bigFile);
  });

  await t.test('7. Gói hỏng checksum bị từ chối', async () => {
    const corruptZip = new AdmZip();
    const manBuf = Buffer.from(JSON.stringify({ format: 'sync2pack', projectId }), 'utf8');
    corruptZip.addFile('sync2_manifest.json', manBuf);
    corruptZip.addFile('__checksum__.txt', Buffer.from('fake_checksum_tampered', 'utf8'));

    const corruptPath = path.join(env.cloudDir, 'corrupt.sync2pack');
    corruptZip.writeZip(corruptPath);

    let corruptRejected = false;
    try {
      await engine.receiveExchangePack(env.machineBDir, corruptPath);
    } catch (err) {
      corruptRejected = true;
      assert.ok(err.message.includes('GÓI BỊ HỎNG CHECKSUM'), 'Phải báo hỏng checksum');
    }
    assert.strictEqual(corruptRejected, true, 'Gói sai checksum phải bị từ chối');
  });

  await t.test('8. Hoàn tác lần nhận phục hồi file cũ', async () => {
    // Lưu nội dung hiện tại của app/main.js trên máy B
    const contentBefore = fs.readFileSync(path.join(env.machineBDir, 'app', 'main.js'), 'utf8');

    // Tạo gói thay đổi app/main.js từ máy A
    fs.writeFileSync(path.join(env.machineADir, 'app', 'main.js'), 'console.log("TEMPORARY ACCIDENTAL CHANGE");\n', 'utf8');
    const undoPack = path.join(env.cloudDir, 'undo_test.sync2pack');
    await engine.createExchangePack(env.machineADir, { outputPackPath: undoPack });

    // Máy B nhận gói
    await engine.receiveExchangePack(env.machineBDir, undoPack);
    assert.strictEqual(fs.readFileSync(path.join(env.machineBDir, 'app', 'main.js'), 'utf8'), 'console.log("TEMPORARY ACCIDENTAL CHANGE");\n');

    // Bấm Hoàn tác (Undo)
    const undoRes = await engine.undoLatestReceive(env.machineBDir);
    assert.strictEqual(undoRes.success, true, 'Hoàn tác phải thành công');

    // Kiểm tra: File đã quay về nội dung trước đó
    const contentRestored = fs.readFileSync(path.join(env.machineBDir, 'app', 'main.js'), 'utf8');
    assert.strictEqual(contentRestored, contentBefore, 'Nội dung file phải được khôi phục chính xác');
  });

  await t.test('9. Nhận hai lần cùng một gói không làm gì thêm (idempotent)', async () => {
    // Nhận lại packPathFromA đã nhận ở test 1
    const secondReceive = await engine.receiveExchangePack(env.machineBDir, packPathFromA);
    assert.strictEqual(secondReceive.appliedCount, 0, 'Lần 2 nhận lại không được ghi đè hay thay đổi thêm file');
    assert.ok(secondReceive.plan.alreadyIdentical.length > 0, 'Các file phải được phân loại là alreadyIdentical');
  });

  await t.test('10. Thử thật (CHỈ ĐỌC) với dự án chỉ định bằng SYNC2_REAL_PROJECT', async () => {
    const realDotaPath = process.env.SYNC2_REAL_PROJECT || '';
    if (!realDotaPath || !fs.existsSync(realDotaPath)) {
      t.diagnostic('Bỏ qua test 10: đặt SYNC2_REAL_PROJECT để chạy thử trên một dự án thật (chỉ đọc).');
      return;
    }

    const crawlPath = path.join(realDotaPath, 'data', 'crawl');
    const storagePath = path.join(realDotaPath, 'storage');
    const crawlMtimeBefore = fs.existsSync(crawlPath) ? fs.statSync(crawlPath).mtimeMs : null;
    const storageMtimeBefore = fs.existsSync(storagePath) ? fs.statSync(storagePath).mtimeMs : null;

    // 1. Kiểm tra status (chỉ đọc)
    const status = await engine.getStatus(realDotaPath);
    assert.ok(status.totalTrackedFiles > 0, 'Phải quét được các file mã nguồn của dự án');

    // 2. Dry-run "Gửi sang máy kia" (mô phỏng, không ghi gì)
    const dryRunRes = await engine.createExchangePack(realDotaPath, { dryRun: true });
    assert.strictEqual(dryRunRes.dryRun, true, 'Phải ở chế độ mô phỏng dry-run');
    assert.ok(dryRunRes.plan, 'Phải có kế hoạch');

    // Kiểm tra danh sách file trong plan KHÔNG chứa data/crawl hay storage
    const plannedFiles = dryRunRes.plan.files.map(f => f.path);
    for (const f of plannedFiles) {
      assert.strictEqual(f.startsWith('data/crawl'), false, `File ${f} trong data/crawl không được lọt vào gói`);
      assert.strictEqual(f.startsWith('storage'), false, `File ${f} trong storage không được lọt vào gói`);
    }

    // Kiểm tra tính toàn vẹn 100% của data/crawl và storage
    if (crawlMtimeBefore) {
      assert.strictEqual(fs.statSync(crawlPath).mtimeMs, crawlMtimeBefore, 'data/crawl nguyên vẹn 100%');
    }
    if (storageMtimeBefore) {
      assert.strictEqual(fs.statSync(storagePath).mtimeMs, storageMtimeBefore, 'storage nguyên vẹn 100%');
    }
  });

  env.cleanup();
});
