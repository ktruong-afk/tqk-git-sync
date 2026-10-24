const fs = require('fs');
const path = require('path');

const SECRET_PATTERNS = [
  /github_pat_[a-zA-Z0-9_]{22,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z-_]{35}/g,
  /stratzToken\s*[:=]\s*['"][^'"]+['"]/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(token|password|secret|bearer)\s*[:=]\s*['"][^'"]+['"]/gi
];

function sanitize(text) {
  if (typeof text !== 'string') {
    text = String(text);
  }
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED_SECRET]');
  }
  return result;
}

class Logger {
  constructor(logFilePath = null) {
    this.logFilePath = logFilePath;
    this.inMemoryLogs = [];
  }

  setLogFilePath(filePath) {
    this.logFilePath = filePath;
  }

  log(level, message, meta = null) {
    const timestamp = new Date().toISOString();
    let sanitizedMsg = sanitize(message);
    let sanitizedMeta = meta ? sanitize(JSON.stringify(meta)) : '';
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${sanitizedMsg} ${sanitizedMeta}`.trim();

    this.inMemoryLogs.push(logLine);
    if (this.inMemoryLogs.length > 500) {
      this.inMemoryLogs.shift();
    }

    if (this.logFilePath) {
      try {
        const dir = path.dirname(this.logFilePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(this.logFilePath, logLine + '\n', 'utf8');
      } catch (err) {
        // Tránh throw nếu ghi log lỗi
      }
    }
    return logLine;
  }

  info(message, meta) {
    return this.log('INFO', message, meta);
  }

  warn(message, meta) {
    return this.log('WARN', message, meta);
  }

  error(message, meta) {
    return this.log('ERROR', message, meta);
  }

  getRecentLogs(limit = 100) {
    return this.inMemoryLogs.slice(-limit);
  }
}

const defaultLogger = new Logger();

module.exports = {
  Logger,
  defaultLogger,
  sanitize
};
