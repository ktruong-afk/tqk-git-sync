document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const btnThemeToggle = document.getElementById('btnThemeToggle');
  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const btnCancelSettings = document.getElementById('btnCancelSettings');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const settingsModal = document.getElementById('settingsModal');

  const inputProjectPath = document.getElementById('inputProjectPath');
  const btnChooseDir = document.getElementById('btnChooseDir');
  const labelMachineName = document.getElementById('labelMachineName');
  const labelTransport = document.getElementById('labelTransport');
  const chkDryRun = document.getElementById('chkDryRun');
  const btnUndo = document.getElementById('btnUndo');

  const btnCheckStatus = document.getElementById('btnCheckStatus');
  const btnSendPack = document.getElementById('btnSendPack');
  const btnReceivePack = document.getElementById('btnReceivePack');
  const btnSyncTwoWay = document.getElementById('btnSyncTwoWay');

  const statusBanner = document.getElementById('statusBanner');
  const bannerTitle = document.getElementById('bannerTitle');
  const bannerDesc = document.getElementById('bannerDesc');

  const planBox = document.getElementById('planBox');
  const planSummaryBadge = document.getElementById('planSummaryBadge');
  const planDetails = document.getElementById('planDetails');
  const btnExecutePlan = document.getElementById('btnExecutePlan');
  const btnCancelPlan = document.getElementById('btnCancelPlan');

  const conflictBox = document.getElementById('conflictBox');
  const conflictList = document.getElementById('conflictList');

  const listChanges = document.getElementById('listChanges');
  const badgeChanges = document.getElementById('badgeChanges');
  const listProtectedPatterns = document.getElementById('listProtectedPatterns');

  // Modal Inputs
  const inputProjectId = document.getElementById('inputProjectId');
  const inputMachineName = document.getElementById('inputMachineName');
  const selectTransport = document.getElementById('selectTransport');
  const txtProtectPatterns = document.getElementById('txtProtectPatterns');
  const txtExcludePatterns = document.getElementById('txtExcludePatterns');

  let currentProjectPath = localStorage.getItem('sync2_last_project') || '';
  let activePendingAction = null; // dùng khi người dùng bấm "Thực hiện thật ngay" từ khung plan

  // 1. THEME TOGGLE
  const savedTheme = localStorage.getItem('sync2_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  btnThemeToggle.textContent = savedTheme === 'dark' ? '🌙' : '☀️';

  btnThemeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('sync2_theme', next);
    btnThemeToggle.textContent = next === 'dark' ? '🌙' : '☀️';
  });

  // 2. LOAD PROJECT CONFIG
  async function loadConfigForProject(projectPath) {
    if (!window.sync2API) return;
    try {
      const cfg = await window.sync2API.getConfig(projectPath);
      labelMachineName.textContent = cfg.machineName || 'May-A';
      labelTransport.textContent = cfg.transport === 'sftp' ? '☁️ Trạm SFTP' : '📦 Gói .sync2pack';

      inputProjectId.value = cfg.projectId || '';
      inputMachineName.value = cfg.machineName || '';
      selectTransport.value = cfg.transport || 'pack';
      txtProtectPatterns.value = (cfg.protect || []).join('\n');
      txtExcludePatterns.value = (cfg.exclude || []).join('\n');

      // Cập nhật danh sách protect view
      listProtectedPatterns.innerHTML = (cfg.protect || [])
        .map(p => `<li><code>${p}</code></li>`)
        .join('');
    } catch (err) {
      console.error('Lỗi load config:', err);
    }
  }

  function setBanner(level, title, message) {
    statusBanner.className = `status-banner banner-${level}`;
    const icons = { good: '✅', info: 'ℹ️', warning: '⚠️', danger: '🚨' };
    statusBanner.querySelector('.banner-icon').textContent = icons[level] || 'ℹ️';
    bannerTitle.textContent = title;
    bannerDesc.textContent = message;
  }

  // 3. CHỌN THƯ MỤC
  btnChooseDir.addEventListener('click', async () => {
    if (!window.sync2API) return;
    const dir = await window.sync2API.selectDirectory();
    if (dir) {
      currentProjectPath = dir;
      inputProjectPath.value = dir;
      localStorage.setItem('sync2_last_project', dir);
      await loadConfigForProject(dir);
      await checkStatus();
    }
  });

  // 4. KIỂM TRA TRẠNG THÁI (STATUS)
  async function checkStatus() {
    if (!currentProjectPath || !window.sync2API) return;
    setBanner('info', 'Đang kiểm tra...', 'Đang quét thư mục và so sánh bản kê...');

    try {
      const res = await window.sync2API.getStatus(currentProjectPath);
      setBanner(res.statusLevel, 'Trạng thái dự án', res.explanation);

      const totalChanges = res.comparison.totalChanges;
      badgeChanges.textContent = `${totalChanges} file`;

      if (totalChanges === 0) {
        listChanges.innerHTML = '<div class="empty-state">✅ Mã nguồn đang ở trạng thái sạch, không có thay đổi nào so với lần đồng bộ trước.</div>';
      } else {
        const rows = [
          ...res.comparison.modified.map(f => `<div class="file-row"><span class="file-status-tag tag-modified">SỬA</span><span>${f.path}</span></div>`),
          ...res.comparison.added.map(f => `<div class="file-row"><span class="file-status-tag tag-added">MỚI</span><span>${f.path}</span></div>`),
          ...res.comparison.deleted.map(f => `<div class="file-row"><span class="file-status-tag tag-deleted">XOÁ</span><span>${f.path}</span></div>`)
        ];
        listChanges.innerHTML = rows.join('');
      }
    } catch (err) {
      setBanner('danger', 'Lỗi kiểm tra', err.message);
    }
  }

  btnCheckStatus.addEventListener('click', checkStatus);

  // 5. GỬI SANG MÁY KIA (TẠO GÓI HOẶC ĐẨY SFTP)
  btnSendPack.addEventListener('click', async () => {
    if (!currentProjectPath || !window.sync2API) return;
    const isDryRun = chkDryRun.checked;

    try {
      const cfg = await window.sync2API.getConfig(currentProjectPath);

      if (cfg.transport === 'sftp') {
        setBanner('info', 'Đang đẩy lên trạm...', 'Đang kết nối tới trạm SFTP đã cấu hình...');
        const res = await window.sync2API.sftpUpload(currentProjectPath, { dryRun: isDryRun });
        if (res.nothingToPack) {
          setBanner('good', 'Không có thay đổi', res.message);
        } else {
          setBanner('good', 'Đẩy lên trạm thành công', `Đã tải gói lên trạm SFTP thành công: ${res.uploadRes.remoteFilePath}`);
        }
        return;
      }

      // Vận chuyển bằng Gói .sync2pack
      if (isDryRun) {
        const res = await window.sync2API.createPack(currentProjectPath, { dryRun: true });
        if (res.nothingToPack) {
          setBanner('good', 'Không có thay đổi', res.message);
          return;
        }

        // Hiện khung "Sẽ làm gì"
        planBox.classList.remove('hidden');
        planSummaryBadge.textContent = `${res.plan.totalFiles} file (${res.plan.totalSizeMb})`;
        planDetails.innerHTML = res.plan.files.map(f => `<div>[${f.status.toUpperCase()}] ${f.path}</div>`).join('');

        setBanner('info', 'Mô phỏng: Sẽ tạo gói', res.message);

        activePendingAction = async () => {
          chkDryRun.checked = false;
          planBox.classList.add('hidden');
          btnSendPack.click();
        };
      } else {
        // Hỏi vị trí lưu gói
        const defaultName = `pack_${cfg.machineName || 'May'}_${Date.now()}.sync2pack`;
        const savePath = await window.sync2API.selectSavePackFile(defaultName);
        if (!savePath) return;

        setBanner('info', 'Đang đóng gói...', 'Đang quét bảo mật và tạo file .sync2pack...');
        const res = await window.sync2API.createPack(currentProjectPath, {
          outputPackPath: savePath,
          dryRun: false
        });

        setBanner('good', 'Tạo gói thành công', `${res.message} Hãy chép file này sang máy kia.`);
        await checkStatus();
      }
    } catch (err) {
      setBanner('danger', 'Chặn tạo gói', err.message);
    }
  });

  // 6. NHẬN VỀ (MỞ GÓI HOẶC TẢI SFTP)
  btnReceivePack.addEventListener('click', async () => {
    if (!currentProjectPath || !window.sync2API) return;
    const isDryRun = chkDryRun.checked;

    try {
      const cfg = await window.sync2API.getConfig(currentProjectPath);

      let packFile = null;
      if (cfg.transport === 'sftp') {
        setBanner('info', 'Đang tải từ trạm...', 'Đang tải gói mới nhất từ máy kia trên trạm SFTP...');
        const res = await window.sync2API.sftpDownload(currentProjectPath, { dryRun: isDryRun });
        handleReceiveResult(res);
        return;
      }

      // Chọn file .sync2pack
      packFile = await window.sync2API.selectPackFile();
      if (!packFile) return;

      setBanner('info', 'Đang phân tích gói...', 'Đang thẩm định checksum, chống zip-slip và so khớp 3 bên...');
      const res = await window.sync2API.receivePack(currentProjectPath, packFile, { dryRun: isDryRun });
      handleReceiveResult(res, packFile);
    } catch (err) {
      setBanner('danger', 'Lỗi nhận gói', err.message);
    }
  });

  function handleReceiveResult(res, packFile = null) {
    if (res.dryRun) {
      planBox.classList.remove('hidden');
      const totalChanges = res.plan.safeUpdates.length + res.plan.safeCreates.length;
      planSummaryBadge.textContent = `${totalChanges} thay đổi`;

      const lines = [
        ...res.plan.safeUpdates.map(f => `<div>[CẬP NHẬT] ${f.path}</div>`),
        ...res.plan.safeCreates.map(f => `<div>[TẠO MỚI] ${f.path}</div>`),
        ...res.plan.conflicts.map(f => `<div style="color:var(--color-danger)">[XUNG ĐỘT] ${f.path} => sẽ lưu thành: ${f.conflictSavePath}</div>`),
        ...res.plan.rejectedProtected.map(f => `<div style="color:var(--color-warning)">[BẢO VỆ BỎ QUA] ${f.path}</div>`)
      ];

      planDetails.innerHTML = lines.join('');
      setBanner('info', 'Mô phỏng nhận gói', res.message);

      activePendingAction = async () => {
        chkDryRun.checked = false;
        planBox.classList.add('hidden');
        if (packFile) {
          const applyRes = await window.sync2API.receivePack(currentProjectPath, packFile, { dryRun: false });
          handleReceiveResult(applyRes);
        }
      };
    } else {
      planBox.classList.add('hidden');
      setBanner('good', 'Nhận gói thành công', res.message);

      // Nếu có conflict -> hiện bảng conflict
      if (res.conflictFilesCreated && res.conflictFilesCreated.length > 0) {
        conflictBox.classList.remove('hidden');
        conflictList.innerHTML = res.conflictFilesCreated.map(c => `
          <div class="conflict-item">
            <div class="conflict-item-title">
              <strong>${c.original}</strong>
              <p>Bản từ máy kia được lưu tại: <code>${c.conflictFile}</code></p>
            </div>
          </div>
        `).join('');
      } else {
        conflictBox.classList.add('hidden');
      }

      checkStatus();
    }
  }

  // 7. THỰC HIỆN KẾ HOẠCH TỪ KHUNG SẼ LÀM GÌ
  btnExecutePlan.addEventListener('click', async () => {
    if (activePendingAction) {
      await activePendingAction();
      activePendingAction = null;
    }
  });

  btnCancelPlan.addEventListener('click', () => {
    planBox.classList.add('hidden');
    activePendingAction = null;
  });

  // 8. ĐỒNG BỘ 2 CHIỀU
  btnSyncTwoWay.addEventListener('click', async () => {
    setBanner('info', 'Đồng bộ 2 chiều', 'Bước 1: Nhận cập nhật từ máy kia...');
    btnReceivePack.click();
  });

  // 9. HOÀN TÁC (UNDO)
  btnUndo.addEventListener('click', async () => {
    if (!currentProjectPath || !window.sync2API) return;
    const confirmUndo = confirm('Bạn có chắc chắn muốn hoàn tác lần nhận gói gần nhất từ thư mục sao lưu?');
    if (!confirmUndo) return;

    try {
      const res = await window.sync2API.undoReceive(currentProjectPath);
      setBanner('good', 'Hoàn tác thành công', `Đã phục hồi ${res.restoredFilesCount} file từ bản sao lưu ${res.backupId}`);
      await checkStatus();
    } catch (err) {
      setBanner('danger', 'Lỗi hoàn tác', err.message);
    }
  });

  // 10. MODAL CÀI ĐẶT
  btnOpenSettings.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
  });

  btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
  btnCancelSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));

  btnSaveSettings.addEventListener('click', async () => {
    if (!currentProjectPath || !window.sync2API) return;
    const newConfig = {
      projectId: inputProjectId.value.trim(),
      machineName: inputMachineName.value.trim(),
      transport: selectTransport.value,
      protect: txtProtectPatterns.value.split('\n').map(s => s.trim()).filter(Boolean),
      exclude: txtExcludePatterns.value.split('\n').map(s => s.trim()).filter(Boolean)
    };

    await window.sync2API.saveConfig(currentProjectPath, newConfig);
    settingsModal.classList.add('hidden');
    await loadConfigForProject(currentProjectPath);
    setBanner('good', 'Đã lưu cài đặt', 'Cài đặt dự án đã được cập nhật thành công.');
  });

  // Khởi tạo ban đầu
  inputProjectPath.value = currentProjectPath;
  await loadConfigForProject(currentProjectPath);
  await checkStatus();
});
