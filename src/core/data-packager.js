const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

class DataPackager {
  constructor(logger = null) {
    this.logger = logger;
  }

  calculateChecksum(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', data => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', err => reject(err));
    });
  }

  async exportFolderToZip(folderPath, outputZipPath, metadata = {}) {
    if (!fs.existsSync(folderPath)) {
      throw new Error(`Thư mục nguồn không tồn tại: ${folderPath}`);
    }

    const zip = new AdmZip();
    zip.addLocalFolder(folderPath);

    // Lưu file meta.json vào trong zip
    const metaInfo = {
      folderPath: path.basename(folderPath),
      createdAt: new Date().toISOString(),
      machine: metadata.machine || 'Unknown',
      notes: metadata.notes || '',
      fileCount: fs.readdirSync(folderPath).length
    };
    zip.addFile('__sync2_meta__.json', Buffer.from(JSON.stringify(metaInfo, null, 2), 'utf8'));

    const outDir = path.dirname(outputZipPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    zip.writeZip(outputZipPath);
    const checksum = await this.calculateChecksum(outputZipPath);

    return {
      outputZipPath,
      checksum,
      metaInfo
    };
  }

  async importFolderFromZip(zipPath, targetFolderPath, options = { overwriteOlderOnly: true }) {
    if (!fs.existsSync(zipPath)) {
      throw new Error(`File ZIP không tồn tại: ${zipPath}`);
    }

    const zip = new AdmZip(zipPath);
    const metaEntry = zip.getEntry('__sync2_meta__.json');
    let meta = null;
    if (metaEntry) {
      try {
        meta = JSON.parse(metaEntry.getData().toString('utf8'));
      } catch {
        meta = null;
      }
    }

    // Kiểm tra an toàn: nếu targetFolderPath đã có dữ liệu và options.overwriteOlderOnly = true
    if (fs.existsSync(targetFolderPath)) {
      const targetStat = fs.statSync(targetFolderPath);
      if (meta && meta.createdAt) {
        const zipCreatedTime = new Date(meta.createdAt).getTime();
        const targetModTime = targetStat.mtime.getTime();

        if (targetModTime > zipCreatedTime && options.overwriteOlderOnly) {
          throw new Error(
            `AN TOÀN: Dữ liệu hiện tại ở thư mục đích (${new Date(targetModTime).toLocaleString()}) mới hơn dữ liệu trong file ZIP (${new Date(zipCreatedTime).toLocaleString()}). Đã hủy giải nén để tránh ghi đè dữ liệu mới hơn!`
          );
        }
      }
    }

    if (!fs.existsSync(targetFolderPath)) {
      fs.mkdirSync(targetFolderPath, { recursive: true });
    }

    // Giải nén các file (bỏ qua __sync2_meta__.json)
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName === '__sync2_meta__.json') continue;
      if (!entry.isDirectory) {
        const destFilePath = path.join(targetFolderPath, entry.entryName);
        fs.mkdirSync(path.dirname(destFilePath), { recursive: true });
        fs.writeFileSync(destFilePath, entry.getData());
      }
    }

    return {
      success: true,
      targetFolderPath,
      extractedCount: entries.length - (metaEntry ? 1 : 0),
      meta
    };
  }
}

module.exports = {
  DataPackager
};
