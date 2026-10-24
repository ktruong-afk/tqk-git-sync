const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { defaultLogger, sanitize } = require('./logger');

const execFileAsync = promisify(execFile);

// Danh sách các cờ hoặc lệnh bị cấm tuyệt đối theo SPEC
const FORBIDDEN_PATTERNS = [
  /--force/i,
  /-f\b/i,
  /\breset\s+--hard\b/i,
  /\bclean\s+-[a-zA-Z]*f/i
];

class GitClient {
  constructor(repoPath, logger = defaultLogger) {
    this.repoPath = repoPath;
    this.logger = logger;
  }

  assertSafeArgs(args) {
    const fullCommand = args.join(' ');
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(fullCommand)) {
        const errorMsg = `LỖI BẢO MẬT: Lệnh git bị cấm thực thi vì có nguy cơ mất an toàn dữ liệu: "git ${fullCommand}"`;
        this.logger.error(errorMsg);
        throw new Error(errorMsg);
      }
    }
  }

  async run(args, options = {}) {
    this.assertSafeArgs(args);
    const cwd = options.cwd || this.repoPath;
    const timeout = options.timeout || 60000;

    const safeLogCmd = sanitize(`git ${args.join(' ')}`);
    this.logger.info(`Chạy lệnh: ${safeLogCmd} [cwd: ${cwd}]`);

    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd,
        timeout,
        maxBuffer: 20 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0', // Ngăn git treo khi đòi hỏi user prompt trong cli/app
          LC_ALL: 'en_US.UTF-8'
        }
      });
      return {
        stdout: stdout || '',
        stderr: stderr || '',
        code: 0
      };
    } catch (err) {
      const cleanError = sanitize(err.message || String(err));
      const cleanStderr = sanitize(err.stderr || '');
      this.logger.error(`Lỗi thực thi git: ${cleanError}`, { stderr: cleanStderr });

      // Phân loại lỗi mạng và xác thực
      const isNetworkError = /Could not resolve host|Failed to connect|Connection refused|Operation timed out|Network is down/i.test(cleanStderr + cleanError);
      const isAuthError = /Authentication failed|Permission denied|fatal: could not read Username/i.test(cleanStderr + cleanError);

      const enhancedError = new Error(`Lỗi Git: ${cleanError}\n${cleanStderr}`);
      enhancedError.isNetworkError = isNetworkError;
      enhancedError.isAuthError = isAuthError;
      enhancedError.rawError = err;
      enhancedError.stderr = cleanStderr;
      throw enhancedError;
    }
  }

  async checkIsGitRepo() {
    try {
      const res = await this.run(['rev-parse', '--is-inside-work-tree']);
      return res.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async getCurrentBranch() {
    try {
      const res = await this.run(['branch', '--show-current']);
      const branch = res.stdout.trim();
      if (branch) return branch;
      // Trong trường hợp detached HEAD
      const resHead = await this.run(['rev-parse', '--short', 'HEAD']);
      return `HEAD (${resHead.stdout.trim()})`;
    } catch (err) {
      return 'unknown';
    }
  }

  async getRemotes() {
    try {
      const res = await this.run(['remote', '-v']);
      const lines = res.stdout.trim().split('\n').filter(Boolean);
      const remotes = {};
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const name = parts[0];
          const url = parts[1];
          const type = parts[2] ? parts[2].replace(/[()]/g, '') : 'fetch';
          if (!remotes[name]) remotes[name] = {};
          remotes[name][type] = sanitize(url);
        }
      }
      return remotes;
    } catch {
      return {};
    }
  }

  async fetch(remote = 'origin', branch = null) {
    if (branch) {
      // Fetch cụ thể nhánh và đảm bảo cập nhật tracking ref origin/<branch>
      return await this.run(['fetch', remote, `${branch}:refs/remotes/${remote}/${branch}`]);
    }
    return await this.run(['fetch', remote]);
  }

  async getAheadBehind(branch = 'main', remoteBranch = 'origin/main') {
    try {
      const res = await this.run(['rev-list', '--left-right', '--count', `${branch}...${remoteBranch}`]);
      const [ahead, behind] = res.stdout.trim().split(/\s+/).map(x => parseInt(x, 10) || 0);
      return { ahead, behind };
    } catch (err) {
      // Có thể remote branch chưa tồn tại
      return { ahead: 0, behind: 0, error: err.message };
    }
  }

  async getStatus() {
    const res = await this.run(['status', '--porcelain=v1', '-uall']);
    const lines = res.stdout.split('\n').filter(l => l.length >= 3);
    const files = [];

    for (const line of lines) {
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      let filePath = line.substring(3).trim();
      // Nếu có rename "from -> to"
      if (filePath.includes(' -> ')) {
        filePath = filePath.split(' -> ')[1];
      }
      // Bỏ ngoặc kép nếu git quote đường dẫn có dấu cách hoặc unicode
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }

      files.push({
        path: filePath,
        indexStatus,
        workTreeStatus,
        isUntracked: indexStatus === '?' && workTreeStatus === '?',
        isModified: workTreeStatus === 'M' || indexStatus === 'M',
        isDeleted: workTreeStatus === 'D' || indexStatus === 'D',
        isAdded: indexStatus === 'A'
      });
    }

    return files;
  }

  async getRemoteFilesChanged(branch = 'main', remoteBranch = 'origin/main') {
    try {
      const res = await this.run(['diff', '--name-status', `${branch}..${remoteBranch}`]);
      const lines = res.stdout.trim().split('\n').filter(Boolean);
      return lines.map(line => {
        const parts = line.split(/\s+/);
        return {
          status: parts[0],
          path: parts.slice(1).join(' ')
        };
      });
    } catch {
      return [];
    }
  }

  async mergeFastForwardOnly(remoteBranch = 'origin/main') {
    // Chỉ fast-forward, tuyệt đối không gộp phân nhánh
    return await this.run(['merge', '--ff-only', remoteBranch]);
  }

  async addFiles(filePaths = ['.']) {
    return await this.run(['add', ...filePaths]);
  }

  async commit(message) {
    return await this.run(['commit', '-m', message]);
  }

  async push(remote = 'origin', branch = 'main') {
    // Luôn là push thường, không force
    return await this.run(['push', remote, branch]);
  }

  async createBackupTag(tagName) {
    return await this.run(['tag', tagName]);
  }

  async getLatestCommitHash() {
    const res = await this.run(['rev-parse', 'HEAD']);
    return res.stdout.trim();
  }

  async resetToCommitSoft(commitHash) {
    // Soft reset an toàn để giữ nguyên working directory
    return await this.run(['reset', '--soft', commitHash]);
  }

  async getDiffBetween(branch1, branch2, filePath = null) {
    const args = ['diff', `${branch1}...${branch2}`];
    if (filePath) {
      args.push('--', filePath);
    }
    const res = await this.run(args);
    return res.stdout;
  }

  async getFileContentAt(ref, filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const res = await this.run(['show', `${ref}:${normalizedPath}`]);
    return res.stdout;
  }
}

module.exports = {
  GitClient,
  FORBIDDEN_PATTERNS
};
