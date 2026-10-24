const path = require('path');
const { spawn } = require('child_process');

class ConflictReporter {
  constructor(gitClient, logger) {
    this.gitClient = gitClient;
    this.logger = logger;
  }

  async analyzeConflict(branch = 'main', remoteBranch = 'origin/main') {
    // Lấy danh sách file thay đổi ở local so với merge-base
    let localChangedFiles = [];
    let remoteChangedFiles = [];

    try {
      const localDiff = await this.gitClient.run(['diff', '--name-only', `${remoteBranch}...${branch}`]);
      localChangedFiles = localDiff.stdout.trim().split('\n').filter(Boolean);
    } catch {
      localChangedFiles = [];
    }

    try {
      const remoteDiff = await this.gitClient.run(['diff', '--name-only', `${branch}...${remoteBranch}`]);
      remoteChangedFiles = remoteDiff.stdout.trim().split('\n').filter(Boolean);
    } catch {
      remoteChangedFiles = [];
    }

    // Các file mà cả 2 bên cùng sửa
    const conflictedFiles = localChangedFiles.filter(f => remoteChangedFiles.includes(f));

    // Lấy diff ngắn gọn cho các file xung đột
    const conflictDetails = [];
    for (const file of conflictedFiles) {
      let diff = '';
      try {
        const diffRes = await this.gitClient.run(['diff', `${branch}...${remoteBranch}`, '--', file]);
        diff = diffRes.stdout.slice(0, 1500); // Giới hạn 1500 ký tự cho preview
      } catch {
        diff = '(Không thể lấy diff)';
      }

      conflictDetails.push({
        file,
        diffPreview: diff,
        options: [
          { id: 'keep_local', label: 'Giữ bản của máy này' },
          { id: 'take_remote', label: 'Lấy bản của máy kia' },
          { id: 'open_editor', label: 'Mở VS Code gộp tay' }
        ]
      });
    }

    return {
      hasConflict: conflictedFiles.length > 0,
      totalConflicted: conflictedFiles.length,
      conflictedFiles,
      conflictDetails,
      localOnlyFiles: localChangedFiles.filter(f => !conflictedFiles.includes(f)),
      remoteOnlyFiles: remoteChangedFiles.filter(f => !conflictedFiles.includes(f)),
      message: conflictedFiles.length > 0
        ? `Phát hiện ${conflictedFiles.length} file bị cả 2 máy chỉnh sửa cùng lúc. Đã dừng an toàn để không mất dữ liệu!`
        : `Nhánh đã phân nhánh (diverged) nhưng không có file trùng lặp chỉnh sửa.`
    };
  }

  async resolveTakeRemote(remoteBranch, filePath) {
    // Lấy nội dung file từ remote branch ghi đè vào working directory
    const normalized = filePath.replace(/\\/g, '/');
    await this.gitClient.run(['checkout', remoteBranch, '--', normalized]);
    return { success: true, file: filePath, resolution: 'take_remote' };
  }

  async resolveKeepLocal(branch, filePath) {
    // Giữ nguyên file ở local (checkout từ HEAD nếu cần phục hồi trạng thái sạch của local)
    const normalized = filePath.replace(/\\/g, '/');
    await this.gitClient.run(['checkout', branch, '--', normalized]);
    return { success: true, file: filePath, resolution: 'keep_local' };
  }

  openInEditor(filePath, repoPath) {
    const fullPath = path.join(repoPath, filePath);
    // Thử mở bằng code (VS Code), nếu không thì notepad trên Windows
    const child = spawn('cmd.exe', ['/c', 'start', 'code', fullPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return { opened: true, path: fullPath };
  }
}

module.exports = {
  ConflictReporter
};
