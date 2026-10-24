const path = require('path');
const micromatch = require('micromatch');
const { GitClient } = require('./git-client');
const { LockManager } = require('./lock-manager');
const { SecretScanner } = require('./secret-scanner');
const { BackupManager } = require('./backup-manager');
const { ConflictReporter } = require('./conflict-reporter');
const { Logger, defaultLogger } = require('./logger');

class SyncEngine {
  constructor(options = {}) {
    this.logger = options.logger || defaultLogger;
  }

  getGitClient(projectPath) {
    return new GitClient(projectPath, this.logger);
  }

  getLockManager(projectPath) {
    return new LockManager(projectPath);
  }

  getSecretScanner(project) {
    return new SecretScanner({
      neverCommit: project.neverCommit,
      maxFileSize: 50 * 1024 * 1024
    });
  }

  getBackupManager(projectPath) {
    return new BackupManager(projectPath, this.logger);
  }

  isPathProtected(relPath, protectPatterns = []) {
    if (!protectPatterns || protectPatterns.length === 0) return false;
    const normalized = relPath.replace(/\\/g, '/');
    return micromatch.isMatch(normalized, protectPatterns, { dot: true });
  }

  async checkStatus(project, currentMachine) {
    const git = this.getGitClient(project.path);
    const lockMgr = this.getLockManager(project.path);

    const isRepo = await git.checkIsGitRepo();
    if (!isRepo) {
      return {
        isRepo: false,
        error: `Thư mục "${project.path}" không phải là một kho Git hợp lệ!`
      };
    }

    const branch = await git.getCurrentBranch();
    const remotes = await git.getRemotes();
    const remoteName = project.remote || 'origin';
    const remoteBranch = `${remoteName}/${project.branch || 'main'}`;

    let networkOk = true;
    let fetchError = null;
    try {
      await git.fetch(remoteName, project.branch || 'main');
    } catch (err) {
      networkOk = false;
      fetchError = err.isNetworkError
        ? 'Không thể kết nối đến GitHub/Remote (vui lòng kiểm tra mạng hoặc URL repo).'
        : (err.isAuthError ? 'Lỗi xác thực Git (chưa đăng nhập hoặc token hết hạn).' : err.message);
      this.logger.warn(`Fetch không thành công: ${fetchError}`);
    }

    const { ahead, behind } = await git.getAheadBehind(branch, remoteBranch);
    const localFiles = await git.getStatus();
    const remoteChangedFiles = await git.getRemoteFilesChanged(branch, remoteBranch);

    // Đánh dấu các file local có nằm trong vùng protected hay không
    const protectPatterns = project.protect || [];
    const localFilesWithProtect = localFiles.map(f => ({
      ...f,
      isProtected: this.isPathProtected(f.path, protectPatterns)
    }));

    // Đánh dấu các file remote sắp đổi có chạm vào protected không
    const remoteFilesWithProtect = remoteChangedFiles.map(f => ({
      ...f,
      isProtected: this.isPathProtected(f.path, protectPatterns)
    }));

    // Kiểm tra trạng thái khóa mềm
    const lockConflict = lockMgr.checkLockConflict(currentMachine);
    const currentLock = lockMgr.readLock();

    // Sinh lời giải thích tiếng Việt thân thiện, dễ hiểu
    let explanation = '';
    let statusLevel = 'good'; // good | info | warning | danger

    if (!networkOk) {
      explanation = `Mất mạng hoặc không kết nối được GitHub: ${fetchError}`;
      statusLevel = 'warning';
    } else if (behind > 0 && ahead > 0) {
      explanation = `CẢNH BÁO XUNG ĐỘT: Máy kia đã đẩy ${behind} thay đổi, nhưng máy này cũng có ${ahead} commit chưa đẩy! Cần cẩn thận khi đồng bộ.`;
      statusLevel = 'danger';
    } else if (behind > 0) {
      explanation = `Máy kia đã đẩy ${behind} thay đổi mới, máy này chưa kéo về. Bấm "Kéo về" để cập nhật.`;
      statusLevel = 'info';
    } else if (ahead > 0) {
      explanation = `Máy này đang có ${ahead} thay đổi đã commit chưa đẩy lên GitHub. Bấm "Đẩy lên" để gửi sang máy kia.`;
      statusLevel = 'info';
    } else if (localFiles.length > 0) {
      explanation = `Có ${localFiles.length} file đang chỉnh sửa cục bộ chưa commit. Sẵn sàng để đẩy lên.`;
      statusLevel = 'info';
    } else {
      explanation = `Mọi thứ đã đồng bộ hoàn hảo với GitHub! Hai máy đang ở cùng trạng thái.`;
      statusLevel = 'good';
    }

    return {
      isRepo: true,
      currentMachine,
      branch,
      remoteName,
      remoteBranch,
      remotes,
      ahead,
      behind,
      networkOk,
      fetchError,
      explanation,
      statusLevel,
      localFiles: localFilesWithProtect,
      remoteChangedFiles: remoteFilesWithProtect,
      lockConflict,
      currentLock,
      protectPatterns
    };
  }

  async pull(project, options = {}) {
    const { dryRun = false, currentMachine = 'May' } = options;
    const git = this.getGitClient(project.path);
    const backupMgr = this.getBackupManager(project.path);
    const conflictReporter = new ConflictReporter(git, this.logger);

    const remoteName = project.remote || 'origin';
    const branchName = project.branch || 'main';
    const remoteBranch = `${remoteName}/${branchName}`;

    // 1. Fetch
    try {
      await git.fetch(remoteName, branchName);
    } catch (err) {
      if (err.isNetworkError || err.isAuthError) {
        throw new Error(`Kéo code thất bại do mạng/xác thực: ${err.message}`);
      }
      throw err;
    }

    // 2. Phân tích trước các file sẽ thay đổi
    const remoteChangedFiles = await git.getRemoteFilesChanged(branchName, remoteBranch);
    const localStatus = await git.getStatus();
    const { ahead, behind } = await git.getAheadBehind(branchName, remoteBranch);

    if (behind === 0 && remoteChangedFiles.length === 0) {
      return {
        success: true,
        alreadyUpToDate: true,
        message: 'Mã nguồn đã ở trạng thái mới nhất, không có gì để kéo về.'
      };
    }

    // Kiểm tra xem file remote sắp kéo về có trùng với file local đang uncommitted không
    const localDirtyPaths = localStatus.map(f => f.path);
    const collidingFiles = remoteChangedFiles
      .filter(rf => localDirtyPaths.includes(rf.path))
      .map(rf => rf.path);

    // Kiểm tra xem có file nào nằm trong `protect` không
    const protectPatterns = project.protect || [];
    const touchingProtected = remoteChangedFiles.filter(rf => this.isPathProtected(rf.path, protectPatterns));

    // Kế hoạch "Sẽ làm gì"
    const plan = {
      action: 'PULL (Kéo về an toàn)',
      dryRun,
      branch: branchName,
      remoteBranch,
      behindCount: behind,
      filesToChange: remoteChangedFiles.map(f => f.path),
      collidingFiles,
      touchingProtected: touchingProtected.map(f => f.path),
      willBackup: true,
      safeMode: 'Fast-Forward Only'
    };

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        plan,
        message: `[MÔ PHỎNG] Dự kiến kéo ${behind} commit (${remoteChangedFiles.length} file thay đổi). Xem chi tiết trong kế hoạch.`
      };
    }

    // Nếu có file đang uncommitted trùng với file remote sắp cập nhật:
    if (collidingFiles.length > 0) {
      throw new Error(
        `XUNG ĐỘT CỤC BỘ: Bạn đang có ${collidingFiles.length} file đã sửa chưa commit trùng với file sắp kéo về (${collidingFiles.slice(0, 3).join(', ')}...). Hãy commit hoặc hoàn tác các file này trước khi kéo!`
      );
    }

    // 3. Tạo ảnh chụp backup
    const filesToBackup = remoteChangedFiles.map(f => f.path);
    const backupManifest = await backupMgr.createPullBackup(git, filesToBackup);

    // 4. Thử Fast-Forward
    try {
      await git.mergeFastForwardOnly(remoteBranch);
      return {
        success: true,
        message: `Đã kéo thành công ${behind} commit từ ${remoteBranch} về máy an toàn!`,
        backupManifest,
        updatedFiles: remoteChangedFiles
      };
    } catch (mergeErr) {
      this.logger.warn(`Không thể fast-forward: ${mergeErr.message}. Phân tích xung đột...`);
      // Phân tích xung đột 2 nhánh diverged
      const conflictReport = await conflictReporter.analyzeConflict(branchName, remoteBranch);
      return {
        success: false,
        diverged: true,
        conflictReport,
        backupManifest,
        message: `Không thể kéo tự động vì cả 2 máy đều có commit mới riêng lẻ. Vui lòng chọn cách xử lý bên dưới.`
      };
    }
  }

  async push(project, options = {}) {
    const {
      dryRun = false,
      commitMessage = null,
      currentMachine = 'May',
      forceOverrideLock = false,
      noteMessage = ''
    } = options;

    const git = this.getGitClient(project.path);
    const lockMgr = this.getLockManager(project.path);
    const scanner = this.getSecretScanner(project);

    const remoteName = project.remote || 'origin';
    const branchName = project.branch || 'main';

    // 1. Kiểm tra local status
    const statusFiles = await git.getStatus();
    const { ahead, behind } = await git.getAheadBehind(branchName, `${remoteName}/${branchName}`);

    if (statusFiles.length === 0 && ahead === 0) {
      return {
        success: true,
        nothingToPush: true,
        message: 'Không có thay đổi nào để đẩy lên.'
      };
    }

    // 2. Quét secret token, file > 50MB, neverCommit
    const filesToScan = statusFiles.map(f => f.path);
    const scanResult = scanner.scanFiles(project.path, filesToScan);

    if (scanResult.blocked) {
      const violations = scanResult.violations;
      const details = violations.map(v => `• [${v.type}] ${v.file}: ${v.message} => ${v.suggestion}`).join('\n');
      throw new Error(`CHẶN ĐẨY LÊN VÌ BẢO MẬT:\n${details}`);
    }

    // 3. Kiểm tra khóa mềm
    const lockConflict = lockMgr.checkLockConflict(currentMachine);
    if (lockConflict.hasConflict && !forceOverrideLock) {
      return {
        success: false,
        lockBlocked: true,
        lock: lockConflict.lock,
        message: lockConflict.warningMessage
      };
    }

    // 4. Chuẩn bị commit message nếu có file chưa commit
    const finalCommitMsg = commitMessage ||
      `Cập nhật từ máy ${currentMachine}: ${statusFiles.length} file (${new Date().toLocaleString('vi-VN')})`;

    const plan = {
      action: 'PUSH (Đẩy lên an toàn)',
      dryRun,
      branch: branchName,
      remote: remoteName,
      aheadCount: ahead,
      uncommittedCount: statusFiles.length,
      filesToCommit: filesToScan,
      commitMessage: finalCommitMsg,
      currentMachine
    };

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        plan,
        message: `[MÔ PHỎNG] Dự kiến commit ${statusFiles.length} file với thông điệp: "${finalCommitMsg}" và đẩy lên ${remoteName}/${branchName}.`
      };
    }

    // 5. Commit nếu có file sửa
    if (statusFiles.length > 0) {
      // Cập nhật file .sync/lock.json vào commit để đồng bộ khóa sang máy kia
      lockMgr.acquireLock(currentMachine, noteMessage || finalCommitMsg);
      // Ghi nhật ký vào SYNC-NOTES.md
      lockMgr.appendSyncNotes(currentMachine, filesToScan, noteMessage);

      await git.addFiles(['.']);
      await git.commit(finalCommitMsg);
    }

    // 6. Push
    try {
      await git.push(remoteName, branchName);
    } catch (pushErr) {
      if (pushErr.isNetworkError || pushErr.isAuthError) {
        throw new Error(`Đẩy code thất bại do mạng/xác thực: ${pushErr.message}`);
      }
      throw pushErr;
    }

    return {
      success: true,
      message: `Đã đẩy thành công lên GitHub (${remoteName}/${branchName})!`,
      committedFiles: filesToScan
    };
  }

  async sync(project, options = {}) {
    // Luồng Sync nhanh: Pull trước -> nếu OK -> Push sau
    this.logger.info(`Bắt đầu đồng bộ nhanh (Sync) cho dự án: ${project.name}`);

    // Bước 1: Kéo về
    const pullResult = await this.pull(project, options);
    if (!pullResult.success) {
      return {
        success: false,
        step: 'pull',
        pullResult,
        message: `Đồng bộ dừng ở bước Kéo về: ${pullResult.message}`
      };
    }

    // Bước 2: Đẩy lên
    const pushResult = await this.push(project, options);
    if (!pushResult.success) {
      return {
        success: false,
        step: 'push',
        pullResult,
        pushResult,
        message: `Kéo về thành công nhưng dừng ở bước Đẩy lên: ${pushResult.message}`
      };
    }

    return {
      success: true,
      pullResult,
      pushResult,
      message: 'Đồng bộ hoàn tất thành công cả 2 chiều Kéo về và Đẩy lên!'
    };
  }

  async releaseLock(project, currentMachine) {
    const lockMgr = this.getLockManager(project.path);
    const git = this.getGitClient(project.path);
    const remoteName = project.remote || 'origin';
    const branchName = project.branch || 'main';

    lockMgr.releaseLock(currentMachine);

    // Commit và push trạng thái trả khóa nếu có thể
    try {
      await git.addFiles(['.sync/lock.json']);
      await git.commit(`Trả khóa từ máy ${currentMachine}`);
      await git.push(remoteName, branchName);
    } catch (err) {
      this.logger.warn(`Trả khóa cục bộ thành công nhưng chưa đẩy lên remote được: ${err.message}`);
    }

    return {
      success: true,
      message: `Đã trả khóa cho máy khác sử dụng.`
    };
  }

  async undoLatestPull(project) {
    const git = this.getGitClient(project.path);
    const backupMgr = this.getBackupManager(project.path);
    return await backupMgr.undoLatestPull(git);
  }
}

module.exports = {
  SyncEngine
};
