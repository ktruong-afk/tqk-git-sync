const fs = require('fs');
const path = require('path');
const micromatch = require('micromatch');

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

const SECRET_PATTERNS = [
  { name: 'GitHub Personal Access Token', pattern: /github_pat_[a-zA-Z0-9_]{22,}/ },
  { name: 'GitHub Classic Token', pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { name: 'OpenAI / Secret API Key', pattern: /sk-[a-zA-Z0-9_-]{20,}/ },
  { name: 'Google API Key', pattern: /AIza[0-9A-Za-z-_]{35}/ },
  { name: 'Stratz API Token', pattern: /stratzToken\s*[:=]\s*['"][^'"]+['"]/i },
  { name: 'Private Key Block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Generic Password/Secret assignment', pattern: /(password|secret|bearer_token)\s*[:=]\s*['"][a-zA-Z0-9_\-\.]{8,}['"]/i }
];

class SecretScanner {
  constructor(options = {}) {
    this.protectPatterns = options.protect || [];
    this.maxFileSize = options.maxFileSize || MAX_FILE_SIZE_BYTES;
    this.allowLargeFiles = Boolean(options.allowLargeFiles);
  }

  isBinaryFile(buffer) {
    const checkLength = Math.min(buffer.length, 1024);
    for (let i = 0; i < checkLength; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  }

  scanFiles(projectPath, relativeFilePaths) {
    const violations = [];

    for (const relPath of relativeFilePaths) {
      const normalizedRelPath = relPath.replace(/\\/g, '/');
      const fullPath = path.join(projectPath, relPath);

      // 1. Kiểm tra nếu file nằm trong danh sách cấm / protect
      if (this.protectPatterns.length > 0 && micromatch.isMatch(normalizedRelPath, this.protectPatterns, { dot: true })) {
        violations.push({
          type: 'PROTECTED_FILE_TOUCHED',
          file: relPath,
          message: `File thuộc danh mục bảo vệ nghiêm ngặt: "${normalizedRelPath}"`,
          suggestion: `Không đưa file thuộc vùng dữ liệu crawl / storage / cá nhân vào gói đồng bộ`
        });
        continue;
      }

      // 2. Kiểm tra file môi trường .env
      const baseName = path.basename(relPath).toLowerCase();
      if (baseName === '.env' || baseName.startsWith('.env.')) {
        violations.push({
          type: 'ENV_FILE',
          file: relPath,
          message: `File môi trường chứa cấu hình nhạy cảm: "${relPath}"`,
          suggestion: `Sử dụng file mẫu .env.example thay vì đưa file .env thật vào gói`
        });
        continue;
      }

      if (!fs.existsSync(fullPath)) {
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        continue;
      }

      // 3. Kiểm tra file > 50MB (trừ khi bật cờ cho phép)
      if (!this.allowLargeFiles && stat.size > this.maxFileSize) {
        const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
        violations.push({
          type: 'FILE_TOO_LARGE',
          file: relPath,
          size: stat.size,
          message: `File vượt quá giới hạn an toàn 50MB (${sizeMb} MB): "${relPath}"`,
          suggestion: `Hãy nén hoặc đưa vào thư mục lưu trữ ngoài`
        });
        continue;
      }

      // 4. Quét chuỗi regex bí mật trong file văn bản
      try {
        const buffer = fs.readFileSync(fullPath);
        if (this.isBinaryFile(buffer)) {
          continue;
        }

        const content = buffer.toString('utf8');
        for (const secretDef of SECRET_PATTERNS) {
          if (secretDef.pattern.test(content)) {
            violations.push({
              type: 'SECRET_TOKEN_DETECTED',
              file: relPath,
              detector: secretDef.name,
              message: `Phát hiện mẫu khoá bí mật (${secretDef.name}) trong file: "${relPath}"`,
              suggestion: `Xoá token/mật khẩu khỏi file trước khi tạo gói đồng bộ`
            });
            break;
          }
        }
      } catch {
        // bỏ qua nếu file không đọc được
      }
    }

    return {
      blocked: violations.length > 0,
      violations
    };
  }
}

module.exports = {
  SecretScanner,
  MAX_FILE_SIZE_BYTES
};
