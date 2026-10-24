const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { Sync2Engine } = require('./core/sync2-engine');
const { SftpTransport } = require('./core/sftp-transport');

let mainWindow = null;
const engine = new Sync2Engine();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 850,
    minHeight: 650,
    title: 'Sync2 - Đồng bộ & Trao đổi File 2 Máy An Toàn',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC HANDLERS
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Chọn thư mục dự án cần đồng bộ'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('select-pack-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Sync2 Pack (*.sync2pack)', extensions: ['sync2pack', 'zip'] }],
    title: 'Chọn gói trao đổi (.sync2pack) nhận từ máy kia'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('select-save-pack-file', async (event, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'update.sync2pack',
    filters: [{ name: 'Sync2 Pack (*.sync2pack)', extensions: ['sync2pack'] }],
    title: 'Chọn vị trí lưu gói trao đổi'
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('get-status', async (event, projectPath) => {
  return await engine.getStatus(projectPath);
});

ipcMain.handle('get-config', async (event, projectPath) => {
  return engine.loadProjectConfig(projectPath);
});

ipcMain.handle('save-config', async (event, projectPath, newConfig) => {
  engine.saveProjectConfig(projectPath, newConfig);
  return { success: true };
});

ipcMain.handle('create-pack', async (event, projectPath, options) => {
  return await engine.createExchangePack(projectPath, options);
});

ipcMain.handle('receive-pack', async (event, projectPath, packFilePath, options) => {
  return await engine.receiveExchangePack(projectPath, packFilePath, options);
});

ipcMain.handle('undo-receive', async (event, projectPath) => {
  return await engine.undoLatestReceive(projectPath);
});

ipcMain.handle('sftp-upload', async (event, projectPath, options) => {
  const config = engine.loadProjectConfig(projectPath);
  const sftp = new SftpTransport({
    host: config.sftp.host,
    port: config.sftp.port,
    username: config.sftp.username,
    privateKeyPath: config.sftp.privateKeyPath,
    logger: engine.logger
  });

  const tempPackPath = path.join(projectPath, '.sync2', `temp_upload_${Date.now()}.sync2pack`);
  const packRes = await engine.createExchangePack(projectPath, {
    outputPackPath: tempPackPath,
    allowLargeFiles: options.allowLargeFiles
  });

  if (packRes.nothingToPack) {
    return { success: true, nothingToPack: true, message: 'Không có thay đổi nào để đẩy lên.' };
  }

  const uploadRes = await sftp.uploadPack(tempPackPath, config.projectId, config.machineName);
  try { require('fs').unlinkSync(tempPackPath); } catch {}
  return { success: true, uploadRes };
});

ipcMain.handle('sftp-download', async (event, projectPath, options) => {
  const config = engine.loadProjectConfig(projectPath);
  const otherMachine = options.fromMachine || (config.machineName === 'May-A' ? 'May-B' : 'May-A');
  const sftp = new SftpTransport({
    host: config.sftp.host,
    port: config.sftp.port,
    username: config.sftp.username,
    privateKeyPath: config.sftp.privateKeyPath,
    logger: engine.logger
  });

  const localSavePath = path.join(projectPath, '.sync2', `download_${otherMachine}.sync2pack`);
  await sftp.downloadLatestPack(config.projectId, otherMachine, localSavePath);

  return await engine.receiveExchangePack(projectPath, localSavePath, { dryRun: options.dryRun });
});
