const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const micromatch = require('micromatch');
const { SecretScanner } = require('./secret-scanner');

function calculateFileSha256(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function calculateBufferSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

class PackManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
  }

  createPack(projectPath, filesToPack, options = {}) {
    const {
      outputPackPath,
      projectId,
      fromMachine = 'May-A',
      protect = [],
      notes = ''
    } = options;

    const scanner = new SecretScanner({
      protect,
      allowLargeFiles: options.allowLargeFiles
    });

    // 1. Quét bảo mật toàn bộ file dự kiến đóng gói
    const relPaths = filesToPack.filter(f => f.status !== 'deleted').map(f => f.path);
    const scanResult = scanner.scanFiles(projectPath, relPaths);

    if (scanResult.blocked) {
      const errDetails = scanResult.violations.map(v => `• [${v.type}] ${v.file}: ${v.message}`).join('\n');
      throw new Error(`CHẶN TẠO GÓI VÌ BẢO MẬT:\n${errDetails}`);
    }

    const zip = new AdmZip();
    const manifestFiles = [];

    // 2. Thêm từng file vào payload/
    for (const item of filesToPack) {
      const normalizedRel = item.path.replace(/\\/g, '/');

      // Chống zip-slip khi đóng gói
      if (normalizedRel.includes('..') || path.isAbsolute(normalizedRel)) {
        throw new Error(`LỖI ĐƯỜNG DẪN: Không được chứa ".." hoặc đường dẫn tuyệt đối: ${normalizedRel}`);
      }

      if (item.status === 'deleted') {
        manifestFiles.push({
          path: normalizedRel,
          status: 'deleted'
        });
        continue;
      }

      const fullPath = path.join(projectPath, item.path);
      if (!fs.existsSync(fullPath)) {
        continue;
      }

      const fileBuffer = fs.readFileSync(fullPath);
      const sha256 = calculateBufferSha256(fileBuffer);
      const stat = fs.statSync(fullPath);

      // Thêm vào zip với prefix payload/
      const zipEntryPath = `payload/${normalizedRel}`;
      zip.addFile(zipEntryPath, fileBuffer);

      manifestFiles.push({
        path: normalizedRel,
        status: item.status || 'modified',
        size: stat.size,
        sha256,
        mtime: stat.mtimeMs
      });
    }

    const manifestData = {
      format: 'sync2pack',
      version: '1.0',
      projectId: projectId || 'default-project',
      fromMachine,
      createdAt: new Date().toISOString(),
      notes,
      totalFiles: manifestFiles.length,
      files: manifestFiles
    };

    // Đưa manifest vào root của zip
    const manifestBuffer = Buffer.from(JSON.stringify(manifestData, null, 2), 'utf8');
    zip.addFile('sync2_manifest.json', manifestBuffer);

    // Tính checksum tổng của manifest + danh sách files
    const manifestSha = calculateBufferSha256(manifestBuffer);
    zip.addFile('__checksum__.txt', Buffer.from(manifestSha, 'utf8'));

    const outDir = path.dirname(outputPackPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    zip.writeZip(outputPackPath);
    const packSha256 = calculateFileSha256(outputPackPath);

    return {
      outputPackPath,
      packSha256,
      manifest: manifestData
    };
  }

  inspectPack(packFilePath, expectedProjectId = null) {
    if (!fs.existsSync(packFilePath)) {
      throw new Error(`File gói trao đổi không tồn tại: ${packFilePath}`);
    }

    let zip;
    try {
      zip = new AdmZip(packFilePath);
    } catch (err) {
      throw new Error(`File gói bị hỏng hoặc không đúng định dạng zip: ${err.message}`);
    }

    // 1. Kiểm tra tính toàn vẹn Checksum
    const manifestEntry = zip.getEntry('sync2_manifest.json');
    const checksumEntry = zip.getEntry('__checksum__.txt');

    if (!manifestEntry || !checksumEntry) {
      throw new Error('Gói không hợp lệ: Thiếu manifest hoặc checksum!');
    }

    const manifestBuffer = manifestEntry.getData();
    const recordedChecksum = checksumEntry.getData().toString('utf8').trim();
    const actualChecksum = calculateBufferSha256(manifestBuffer);

    if (recordedChecksum !== actualChecksum) {
      throw new Error('GÓI BỊ HỎNG CHECKSUM: Nội dung bên trong gói đã bị sửa đổi hoặc truyền tải lỗi!');
    }

    let manifest;
    try {
      manifest = JSON.parse(manifestBuffer.toString('utf8'));
    } catch {
      throw new Error('Lỗi cú pháp JSON trong manifest của gói!');
    }

    // 2. Kiểm tra khớp Project ID
    if (expectedProjectId && manifest.projectId && manifest.projectId !== expectedProjectId) {
      throw new Error(
        `KHÁC MÃ DỰ ÁN: Gói này thuộc dự án "${manifest.projectId}", trong khi máy này đang mở dự án "${expectedProjectId}"!`
      );
    }

    // 3. Quét kiểm tra ZIP-SLIP trên tất cả các entry
    const entries = zip.getEntries();
    for (const entry of entries) {
      const entryName = entry.entryName.replace(/\\/g, '/');
      if (entryName.includes('..') || entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) {
        throw new Error(
          `CẢNH BÁO BẢO MẬT ZIP-SLIP: Gói chứa đường dẫn bất hợp pháp "${entryName}". Đã từ chối xử lý!`
        );
      }
    }

    // 4. Quét kiểm tra ZIP-SLIP trên manifest files
    if (Array.isArray(manifest.files)) {
      for (const f of manifest.files) {
        if (!f.path) continue;
        const norm = f.path.replace(/\\/g, '/');
        if (norm.includes('..') || norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
          throw new Error(
            `CẢNH BÁO BẢO MẬT ZIP-SLIP: File trong manifest chứa đường dẫn bất hợp pháp "${f.path}". Đã từ chối xử lý!`
          );
        }
      }
    }

    return {
      zip,
      manifest,
      entriesCount: entries.length,
      packSha256: calculateFileSha256(packFilePath)
    };
  }
}

module.exports = {
  PackManager,
  calculateFileSha256
};
