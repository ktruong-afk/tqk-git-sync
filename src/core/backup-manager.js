const fs = require('fs');
const path = require('path');
const { defaultLogger } = require('./logger');

class BackupManager {
  constructor(projectPath, logger = defaultLogger) {
    this.projectPath = projectPath;
    this.backupRootDir = path.join(this.projectPath, '.sync2', 'backups');
    this.logger = logger;
  }

  ensureRootDir() {
    if (!fs.existsSync(this.backupRootDir)) {
      fs.mkdirSync(this.backupRootDir, { recursive: true });
    }
  }

  generateBackupId() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const min = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;
  }

  createPreReceiveBackup(filesToChange = []) {
    this.ensureRootDir();
    const backupId = this.generateBackupId();
    const targetDir = path.join(this.backupRootDir, backupId);
    fs.mkdirSync(targetDir, { recursive: true });

    const backedUpFiles = [];

    for (const relPath of filesToChange) {
      const srcPath = path.join(this.projectPath, relPath);
      if (fs.existsSync(srcPath) && !fs.statSync(srcPath).isDirectory()) {
        const destPath = path.join(targetDir, 'files', relPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        backedUpFiles.push(relPath);
      }
    }

    const manifest = {
      backupId,
      createdAt: new Date().toISOString(),
      backedUpFiles
    };

    fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    this.logger.info(`Đã tạo ảnh chụp sao lưu tại ${targetDir} (${backedUpFiles.length} file)`);

    return manifest;
  }

  getBackupList() {
    if (!fs.existsSync(this.backupRootDir)) {
      return [];
    }
    const entries = fs.readdirSync(this.backupRootDir, { withFileTypes: true });
    const backups = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifestPath = path.join(this.backupRootDir, entry.name, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const raw = fs.readFileSync(manifestPath, 'utf8');
            backups.push(JSON.parse(raw));
          } catch {
            // bỏ qua
          }
        }
      }
    }

    backups.sort((a, b) => (b.backupId > a.backupId ? 1 : -1));
    return backups;
  }

  undoLatestBackup() {
    const list = this.getBackupList();
    if (list.length === 0) {
      throw new Error('Không tìm thấy bản sao lưu nào để hoàn tác!');
    }

    const latest = list[0];
    const backupDir = path.join(this.backupRootDir, latest.backupId);
    const filesDir = path.join(backupDir, 'files');

    this.logger.info(`Đang hoàn tác về bản sao lưu: ${latest.backupId}`);

    if (fs.existsSync(filesDir)) {
      for (const relPath of latest.backedUpFiles) {
        const srcPath = path.join(filesDir, relPath);
        const destPath = path.join(this.projectPath, relPath);
        if (fs.existsSync(srcPath)) {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcPath, destPath);
        }
      }
    }

    this.logger.info(`Hoàn tất phục hồi ${latest.backedUpFiles.length} file từ ảnh chụp ${latest.backupId}`);
    return {
      success: true,
      backupId: latest.backupId,
      restoredFilesCount: latest.backedUpFiles.length,
      files: latest.backedUpFiles
    };
  }
}

module.exports = {
  BackupManager
};
