const fs = require('fs');
const path = require('path');

class LockManager {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.lockDir = path.join(this.repoPath, '.sync');
    this.lockFile = path.join(this.lockDir, 'lock.json');
    this.notesFile = path.join(this.repoPath, 'SYNC-NOTES.md');
  }

  ensureDir() {
    if (!fs.existsSync(this.lockDir)) {
      fs.mkdirSync(this.lockDir, { recursive: true });
    }
  }

  readLock() {
    try {
      if (!fs.existsSync(this.lockFile)) {
        return null;
      }
      const raw = fs.readFileSync(this.lockFile, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  checkLockConflict(currentMachineName) {
    const lock = this.readLock();
    if (!lock) {
      return { hasConflict: false, lock: null };
    }

    // Nếu trạng thái là idle thì không có xung đột
    if (lock.status === 'idle') {
      return { hasConflict: false, lock };
    }

    // Nếu holder là máy khác và đang 'working'
    if (lock.holder && lock.holder !== currentMachineName && lock.status === 'working') {
      return {
        hasConflict: true,
        lock,
        warningMessage: `CẢNH BÁO: Máy "${lock.holder}" đang giữ khóa làm việc từ lúc ${lock.updatedAt}. Đẩy lên lúc này có thể ghi đè công việc của máy kia!`
      };
    }

    return { hasConflict: false, lock };
  }

  acquireLock(machineName, message = 'Đang chỉnh sửa') {
    this.ensureDir();
    const lockData = {
      holder: machineName,
      status: 'working',
      updatedAt: new Date().toISOString(),
      message
    };
    fs.writeFileSync(this.lockFile, JSON.stringify(lockData, null, 2), 'utf8');
    return lockData;
  }

  releaseLock(machineName) {
    this.ensureDir();
    const currentLock = this.readLock();
    const lockData = {
      holder: machineName,
      status: 'idle',
      updatedAt: new Date().toISOString(),
      message: 'Sẵn sàng, đã hoàn thành công việc gần nhất'
    };
    fs.writeFileSync(this.lockFile, JSON.stringify(lockData, null, 2), 'utf8');
    return lockData;
  }

  appendSyncNotes(machineName, changedFiles = [], customMessage = '') {
    try {
      const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const fileListSummary = changedFiles.slice(0, 10).map(f => `  - ${f}`).join('\n') +
        (changedFiles.length > 10 ? `\n  - ... và ${changedFiles.length - 10} file khác` : '');

      const entry = `\n### [${timestamp} UTC] Máy: ${machineName}\n` +
        (customMessage ? `- Ghi chú: ${customMessage}\n` : '') +
        `- Thay đổi (${changedFiles.length} file):\n${fileListSummary || '  - (Không có file đổi)'}\n`;

      let header = '';
      if (!fs.existsSync(this.notesFile)) {
        header = `# NHẬT KÝ ĐỒNG BỘ (SYNC-NOTES)\n*Tự động ghi lại lịch sử đồng bộ giữa các máy*\n`;
      }

      fs.appendFileSync(this.notesFile, header + entry, 'utf8');
    } catch (err) {
      // Ghi chú phụ không được làm fail luồng chính
    }
  }
}

module.exports = {
  LockManager
};
