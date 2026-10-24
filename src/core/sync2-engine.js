const fs = require('fs');
const path = require('path');
const os = require('os');
const { ManifestBuilder, DEFAULT_EXCLUDE, DEFAULT_PROTECT } = require('./manifest-builder');
const { SecretScanner } = require('./secret-scanner');
const { PackManager } = require('./pack-manager');
const { ThreeWaySync } = require('./three-way-sync');
const { BackupManager } = require('./backup-manager');
const { SftpTransport } = require('./sftp-transport');
const { Logger, defaultLogger } = require('./logger');

class Sync2Engine {
  constructor(options = {}) {
    this.logger = options.logger || defaultLogger;
    this.packManager = new PackManager({ logger: this.logger });
    this.threeWaySync = new ThreeWaySync({ logger: this.logger });
  }

  loadProjectConfig(projectPath) {
    const sync2Dir = path.join(projectPath, '.sync2');
    const configPath = path.join(sync2Dir, 'config.json');

    const defaultConfig = {
      projectId: path.basename(projectPath),
      machineName: os.hostname() || 'May-A',
      protect: DEFAULT_PROTECT,
      exclude: DEFAULT_EXCLUDE,
      transport: 'pack', // 'pack' | 'sftp' | 'lan'
      sftp: {
        host: '',
        port: 22,
        username: '',
        privateKeyPath: ''
      }
    };

    if (!fs.existsSync(configPath)) {
      return defaultConfig;
    }

    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...defaultConfig,
        ...parsed,
        protect: parsed.protect || DEFAULT_PROTECT,
        exclude: parsed.exclude || DEFAULT_EXCLUDE
      };
    } catch {
      return defaultConfig;
    }
  }

  saveProjectConfig(projectPath, config) {
    const sync2Dir = path.join(projectPath, '.sync2');
    if (!fs.existsSync(sync2Dir)) {
      fs.mkdirSync(sync2Dir, { recursive: true });
    }
    const configPath = path.join(sync2Dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  initProject(projectPath, options = {}) {
    const config = this.loadProjectConfig(projectPath);
    if (options.machineName) config.machineName = options.machineName;
    if (options.projectId) config.projectId = options.projectId;
    if (options.protect) config.protect = options.protect;
    if (options.exclude) config.exclude = options.exclude;

    this.saveProjectConfig(projectPath, config);

    // Tạo bản base.json ban đầu nếu chưa có
    const manifestBuilder = new ManifestBuilder({
      exclude: config.exclude,
      protect: config.protect
    });

    const currentBase = manifestBuilder.loadBaseManifest(projectPath);
    if (!currentBase) {
      const scan = manifestBuilder.scanProject(projectPath);
      manifestBuilder.saveBaseManifest(projectPath, {
        projectId: config.projectId,
        lastSyncedAt: new Date().toISOString(),
        files: scan.files
      });
    }

    return config;
  }

  async getStatus(projectPath) {
    const config = this.loadProjectConfig(projectPath);
    const manifestBuilder = new ManifestBuilder({
      exclude: config.exclude,
      protect: config.protect
    });

    const baseManifest = manifestBuilder.loadBaseManifest(projectPath);
    const currentManifest = manifestBuilder.scanProject(projectPath);
    const comparison = manifestBuilder.compareWithBase(currentManifest, baseManifest);

    let explanation = '';
    let statusLevel = 'good'; // good | info | warning

    if (comparison.totalChanges > 0) {
      explanation = `Có ${comparison.totalChanges} thay đổi cục bộ so với lần đồng bộ trước (${comparison.modified.length} sửa, ${comparison.added.length} mới, ${comparison.deleted.length} đã xoá). Sẵn sàng tạo gói để gửi sang máy kia.`;
      statusLevel = 'info';
    } else {
      explanation = `Không có thay đổi mã nguồn nào so với lần đồng bộ trước. Mã nguồn đang ở trạng thái sạch.`;
      statusLevel = 'good';
    }

    return {
      projectId: config.projectId,
      machineName: config.machineName,
      lastSyncedAt: baseManifest ? baseManifest.lastSyncedAt : null,
      protect: config.protect,
      exclude: config.exclude,
      comparison,
      explanation,
      statusLevel,
      totalTrackedFiles: Object.keys(currentManifest.files).length
    };
  }

  async createExchangePack(projectPath, options = {}) {
    const {
      outputPackPath = null,
      dryRun = false,
      notes = '',
      allowLargeFiles = false
    } = options;

    const config = this.loadProjectConfig(projectPath);
    const manifestBuilder = new ManifestBuilder({
      exclude: config.exclude,
      protect: config.protect
    });

    const baseManifest = manifestBuilder.loadBaseManifest(projectPath);
    const currentManifest = manifestBuilder.scanProject(projectPath);
    const comparison = manifestBuilder.compareWithBase(currentManifest, baseManifest);

    const changedFiles = [
      ...comparison.modified.map(f => ({ path: f.path, status: 'modified', size: f.size })),
      ...comparison.added.map(f => ({ path: f.path, status: 'added', size: f.size })),
      ...comparison.deleted.map(f => ({ path: f.path, status: 'deleted' }))
    ];

    if (changedFiles.length === 0) {
      return {
        success: true,
        nothingToPack: true,
        message: 'Không có thay đổi nào để tạo gói.'
      };
    }

    const targetPackPath = outputPackPath ||
      path.join(projectPath, '.sync2', `pack_${config.machineName}_${Date.now()}.sync2pack`);

    // Tính tổng dung lượng dự kiến
    const totalBytes = changedFiles.filter(f => f.size).reduce((sum, f) => sum + f.size, 0);
    const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);

    // Quét bảo mật thử trước
    const scanner = new SecretScanner({
      protect: config.protect,
      allowLargeFiles
    });
    const pathsToScan = changedFiles.filter(f => f.status !== 'deleted').map(f => f.path);
    const scanResult = scanner.scanFiles(projectPath, pathsToScan);

    if (scanResult.blocked) {
      const errDetails = scanResult.violations.map(v => `• [${v.type}] ${v.file}: ${v.message}`).join('\n');
      throw new Error(`CHẶN TẠO GÓI VÌ BẢO MẬT:\n${errDetails}`);
    }

    const plan = {
      action: 'GỬI SANG MÁY KIA (Tạo gói trao đổi)',
      dryRun,
      projectId: config.projectId,
      fromMachine: config.machineName,
      targetPackPath,
      totalFiles: changedFiles.length,
      totalSizeMb: `${totalMb} MB`,
      files: changedFiles
    };

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        plan,
        message: `[MÔ PHỎNG] Dự kiến đóng gói ${changedFiles.length} file (${totalMb} MB) vào "${path.basename(targetPackPath)}".`
      };
    }

    const packResult = this.packManager.createPack(projectPath, changedFiles, {
      outputPackPath: targetPackPath,
      projectId: config.projectId,
      fromMachine: config.machineName,
      protect: config.protect,
      notes,
      allowLargeFiles
    });

    return {
      success: true,
      dryRun: false,
      packPath: packResult.outputPackPath,
      packSha256: packResult.packSha256,
      manifest: packResult.manifest,
      message: `Đã tạo gói trao đổi thành công (${changedFiles.length} file, ${totalMb} MB)! Hãy sao chép file "${path.basename(targetPackPath)}" sang máy kia.`
    };
  }

  async receiveExchangePack(projectPath, packFilePath, options = {}) {
    const { dryRun = false } = options;
    const config = this.loadProjectConfig(projectPath);

    // 1. Kiểm tra và mở gói
    const inspected = this.packManager.inspectPack(packFilePath, config.projectId);

    // 2. So khớp 3 bên và lập kế hoạch an toàn
    const plan = this.threeWaySync.analyzeThreeWay(projectPath, inspected, {
      protect: config.protect,
      currentMachine: config.machineName
    });

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        plan,
        fromMachine: inspected.manifest.fromMachine,
        message: `[MÔ PHỎNG] Gói từ máy "${inspected.manifest.fromMachine}". Sẽ ghi ${plan.safeUpdates.length + plan.safeCreates.length} file, xung đột ${plan.conflicts.length} file, bỏ qua ${plan.rejectedProtected.length} file bảo vệ.`
      };
    }

    // 3. Áp dụng kế hoạch
    const applyResult = this.threeWaySync.applyPlan(projectPath, inspected, plan, {
      dryRun: false,
      protect: config.protect,
      currentMachine: config.machineName
    });

    return {
      success: true,
      dryRun: false,
      ...applyResult,
      plan
    };
  }

  async undoLatestReceive(projectPath) {
    const backupMgr = new BackupManager(projectPath, this.logger);
    return backupMgr.undoLatestBackup();
  }
}

module.exports = {
  Sync2Engine
};
