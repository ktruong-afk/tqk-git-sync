const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const micromatch = require('micromatch');

const DEFAULT_EXCLUDE = [
  'node_modules/**',
  'dist/**',
  'release/**',
  'build/**',
  '.git/**',
  '.sync2/**',
  '.sync-backups/**',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini'
];

const DEFAULT_PROTECT = [
  'data/crawl/**',
  'data/game/**',
  'storage/**',
  'node_modules/**',
  'dist/**',
  'release/**',
  'legacy/**'
];

function calculateFileSha256(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

class ManifestBuilder {
  constructor(options = {}) {
    this.excludePatterns = options.exclude || DEFAULT_EXCLUDE;
    this.protectPatterns = options.protect || DEFAULT_PROTECT;
  }

  isExcluded(relPath) {
    const normalized = relPath.replace(/\\/g, '/');
    return micromatch.isMatch(normalized, this.excludePatterns, { dot: true });
  }

  isProtected(relPath) {
    const normalized = relPath.replace(/\\/g, '/');
    return micromatch.isMatch(normalized, this.protectPatterns, { dot: true });
  }

  scanProject(projectPath) {
    const manifest = {
      scannedAt: new Date().toISOString(),
      files: {}
    };

    const walk = (currentDir, relBase = '') => {
      if (!fs.existsSync(currentDir)) return;
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
        const normalizedRel = relPath.replace(/\\/g, '/');

        // Bỏ qua nếu thuộc exclude
        if (this.isExcluded(normalizedRel)) {
          continue;
        }

        // Bỏ qua nếu thuộc protect (mặc định không đưa dữ liệu crawl/storage vào manifest chia sẻ)
        if (this.isProtected(normalizedRel)) {
          continue;
        }

        if (entry.isDirectory()) {
          walk(fullPath, normalizedRel);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(fullPath);
            const sha256 = calculateFileSha256(fullPath);
            manifest.files[normalizedRel] = {
              size: stat.size,
              mtime: stat.mtimeMs,
              sha256
            };
          } catch {
            // bỏ qua file đang bị khoá bởi process khác
          }
        }
      }
    };

    walk(projectPath);
    return manifest;
  }

  loadBaseManifest(projectPath) {
    const basePath = path.join(projectPath, '.sync2', 'base.json');
    if (!fs.existsSync(basePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(basePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  saveBaseManifest(projectPath, manifestData) {
    const sync2Dir = path.join(projectPath, '.sync2');
    if (!fs.existsSync(sync2Dir)) {
      fs.mkdirSync(sync2Dir, { recursive: true });
    }
    const basePath = path.join(sync2Dir, 'base.json');
    fs.writeFileSync(basePath, JSON.stringify(manifestData, null, 2), 'utf8');
  }

  compareWithBase(currentManifest, baseManifest) {
    const baseFiles = (baseManifest && baseManifest.files) ? baseManifest.files : {};
    const currFiles = currentManifest.files || {};

    const modified = [];
    const added = [];
    const deleted = [];
    const unchanged = [];

    // Duyệt qua các file hiện tại
    for (const [relPath, currInfo] of Object.entries(currFiles)) {
      const baseInfo = baseFiles[relPath];
      if (!baseInfo) {
        added.push({ path: relPath, ...currInfo });
      } else if (baseInfo.sha256 !== currInfo.sha256) {
        modified.push({ path: relPath, ...currInfo, baseSha256: baseInfo.sha256 });
      } else {
        unchanged.push({ path: relPath, ...currInfo });
      }
    }

    // Duyệt các file có trong base nhưng đã bị xoá ở hiện tại
    for (const [relPath, baseInfo] of Object.entries(baseFiles)) {
      if (!currFiles[relPath]) {
        deleted.push({ path: relPath, ...baseInfo });
      }
    }

    return {
      modified,
      added,
      deleted,
      unchanged,
      totalChanges: modified.length + added.length + deleted.length
    };
  }
}

module.exports = {
  ManifestBuilder,
  DEFAULT_EXCLUDE,
  DEFAULT_PROTECT,
  calculateFileSha256
};
