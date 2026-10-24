const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const micromatch = require('micromatch');
const { ManifestBuilder, calculateFileSha256 } = require('./manifest-builder');
const { BackupManager } = require('./backup-manager');

class ThreeWaySync {
  constructor(options = {}) {
    this.logger = options.logger || console;
  }

  formatTimestampForFilename() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  isProtected(relPath, protectPatterns = []) {
    if (!protectPatterns || protectPatterns.length === 0) return false;
    const normalized = relPath.replace(/\\/g, '/');
    return micromatch.isMatch(normalized, protectPatterns, { dot: true });
  }

  analyzeThreeWay(projectPath, inspectedPack, options = {}) {
    const { protect = [], currentMachine = 'May-B' } = options;
    const manifestBuilder = new ManifestBuilder({ protect });

    const baseManifest = manifestBuilder.loadBaseManifest(projectPath) || { files: {} };
    const baseFiles = baseManifest.files || {};

    const currentManifest = manifestBuilder.scanProject(projectPath);
    const localFiles = currentManifest.files || {};

    const incomingManifest = inspectedPack.manifest;
    const incomingFiles = incomingManifest.files || [];

    const plan = {
      projectId: incomingManifest.projectId,
      fromMachine: incomingManifest.fromMachine,
      createdAt: incomingManifest.createdAt,
      safeUpdates: [],
      safeCreates: [],
      conflicts: [],
      alreadyIdentical: [],
      remoteDeletes: [],
      rejectedProtected: []
    };

    for (const inc of incomingFiles) {
      const relPath = inc.path.replace(/\\/g, '/');

      // 1. Kiểm tra protect: Tuyệt đối không bao giờ cho phép đè vào file protected
      if (this.isProtected(relPath, protect)) {
        plan.rejectedProtected.push({
          path: relPath,
          reason: 'File nằm trong danh mục bảo vệ nghiêm ngặt (data/crawl, storage, ...)'
        });
        continue;
      }

      const baseInfo = baseFiles[relPath];
      const localInfo = localFiles[relPath];

      // File bị xoá ở máy gửi
      if (inc.status === 'deleted') {
        if (localInfo) {
          plan.remoteDeletes.push({
            path: relPath,
            message: `Máy "${incomingManifest.fromMachine}" đã xoá file này. Mặc định không tự xoá để tránh mất dữ liệu.`
          });
        }
        continue;
      }

      // File mới hoàn toàn (cả base và local đều chưa có)
      if (!baseInfo && !localInfo) {
        plan.safeCreates.push({
          path: relPath,
          incomingSha256: inc.sha256,
          size: inc.size
        });
        continue;
      }

      // Local và Incoming có cùng nội dung
      if (localInfo && localInfo.sha256 === inc.sha256) {
        plan.alreadyIdentical.push({
          path: relPath,
          sha256: inc.sha256
        });
        continue;
      }

      // Trường hợp 1 bên sửa: Local chưa sửa so với base, nhưng Incoming có sửa
      const localUntouched = baseInfo && localInfo && baseInfo.sha256 === localInfo.sha256;
      if (localUntouched) {
        plan.safeUpdates.push({
          path: relPath,
          incomingSha256: inc.sha256,
          baseSha256: baseInfo.sha256,
          size: inc.size
        });
        continue;
      }

      // Trường hợp xung đột: Cả 2 bên đều sửa khác nhau, hoặc cả 2 cùng tạo mới file cùng tên nhưng khác nội dung!
      const isConflict = (!baseInfo && localInfo && localInfo.sha256 !== inc.sha256) ||
        (baseInfo && localInfo && baseInfo.sha256 !== localInfo.sha256 && baseInfo.sha256 !== inc.sha256);

      if (isConflict) {
        const ext = path.extname(relPath);
        const nameWithoutExt = relPath.slice(0, relPath.length - ext.length);
        const conflictFilename = `${nameWithoutExt}.conflict-${incomingManifest.fromMachine}-${this.formatTimestampForFilename()}${ext}`;

        plan.conflicts.push({
          path: relPath,
          conflictSavePath: conflictFilename,
          localSha256: localInfo ? localInfo.sha256 : 'none',
          incomingSha256: inc.sha256,
          message: `Xung đột: Cả hai máy đều chỉnh sửa file này khác nhau. Sync2 giữ nguyên file của bạn và lưu file máy kia thành "${conflictFilename}"`
        });
        continue;
      }

      // Mặc định an toàn
      plan.safeUpdates.push({
        path: relPath,
        incomingSha256: inc.sha256,
        size: inc.size
      });
    }

    return plan;
  }

  applyPlan(projectPath, inspectedPack, plan, options = {}) {
    const { dryRun = false, protect = [], currentMachine = 'May' } = options;
    const zip = inspectedPack.zip;
    const backupMgr = new BackupManager(projectPath, this.logger);
    const manifestBuilder = new ManifestBuilder({ protect });

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        plan,
        message: `[MÔ PHỎNG] Dự kiến: ${plan.safeUpdates.length} cập nhật, ${plan.safeCreates.length} tạo mới, ${plan.conflicts.length} xung đột (lưu song song), ${plan.rejectedProtected.length} file bảo vệ bỏ qua.`
      };
    }

    // 1. Sao lưu các file sắp bị thay đổi
    const filesToBackup = plan.safeUpdates.map(f => f.path);
    let backupManifest = null;
    if (filesToBackup.length > 0) {
      backupManifest = backupMgr.createPreReceiveBackup(filesToBackup);
    }

    const appliedFiles = [];
    const conflictFilesCreated = [];

    // 2. Áp dụng safeCreates và safeUpdates (Atomic Write)
    const writeItems = [...plan.safeCreates, ...plan.safeUpdates];

    for (const item of writeItems) {
      const relPath = item.path;

      // Kiểm tra an toàn lần cuối với protect
      if (this.isProtected(relPath, protect)) {
        continue;
      }

      const zipEntryName = `payload/${relPath}`;
      const zipEntry = zip.getEntry(zipEntryName);
      if (!zipEntry) {
        continue;
      }

      const buffer = zipEntry.getData();
      const targetFullPath = path.join(projectPath, relPath);
      const targetDir = path.dirname(targetFullPath);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Ghi ra file tạm trước
      const tempPath = `${targetFullPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}`;
      fs.writeFileSync(tempPath, buffer);

      // Đổi tên file tạm đè lên target (atomic)
      fs.renameSync(tempPath, targetFullPath);

      // Kiểm tra lại SHA256 sau khi ghi
      const writtenSha = calculateFileSha256(targetFullPath);
      if (item.incomingSha256 && writtenSha !== item.incomingSha256) {
        throw new Error(`LỖI TOÀN VẸN: File "${relPath}" sau khi ghi có mã SHA256 không khớp!`);
      }

      appliedFiles.push(relPath);
    }

    // 3. Xử lý các file Conflict: Giữ nguyên file local, ghi file incoming thành conflictSavePath
    for (const conf of plan.conflicts) {
      const zipEntryName = `payload/${conf.path}`;
      const zipEntry = zip.getEntry(zipEntryName);
      if (!zipEntry) continue;

      const buffer = zipEntry.getData();
      const conflictFullPath = path.join(projectPath, conf.conflictSavePath);
      const conflictDir = path.dirname(conflictFullPath);

      if (!fs.existsSync(conflictDir)) {
        fs.mkdirSync(conflictDir, { recursive: true });
      }

      fs.writeFileSync(conflictFullPath, buffer);
      conflictFilesCreated.push({
        original: conf.path,
        conflictFile: conf.conflictSavePath
      });
    }

    // 4. Cập nhật base.json
    const updatedBase = manifestBuilder.scanProject(projectPath);
    manifestBuilder.saveBaseManifest(projectPath, {
      projectId: plan.projectId,
      lastSyncedAt: new Date().toISOString(),
      appliedPackFrom: plan.fromMachine,
      files: updatedBase.files
    });

    return {
      success: true,
      appliedCount: appliedFiles.length,
      conflictsCount: conflictFilesCreated.length,
      rejectedProtectedCount: plan.rejectedProtected.length,
      backupId: backupManifest ? backupManifest.backupId : null,
      appliedFiles,
      conflictFilesCreated,
      message: `Đã nhận gói thành công! Cập nhật ${appliedFiles.length} file.` +
        (conflictFilesCreated.length > 0 ? ` Có ${conflictFilesCreated.length} file xung đột đã được lưu song song an toàn.` : '')
    };
  }
}

module.exports = {
  ThreeWaySync
};
