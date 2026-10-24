const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sync2API', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectPackFile: () => ipcRenderer.invoke('select-pack-file'),
  selectSavePackFile: (defaultName) => ipcRenderer.invoke('select-save-pack-file', defaultName),
  getStatus: (projectPath) => ipcRenderer.invoke('get-status', projectPath),
  getConfig: (projectPath) => ipcRenderer.invoke('get-config', projectPath),
  saveConfig: (projectPath, newConfig) => ipcRenderer.invoke('save-config', projectPath, newConfig),
  createPack: (projectPath, options) => ipcRenderer.invoke('create-pack', projectPath, options),
  receivePack: (projectPath, packFilePath, options) => ipcRenderer.invoke('receive-pack', projectPath, packFilePath, options),
  undoReceive: (projectPath) => ipcRenderer.invoke('undo-receive', projectPath),
  sftpUpload: (projectPath, options) => ipcRenderer.invoke('sftp-upload', projectPath, options),
  sftpDownload: (projectPath, options) => ipcRenderer.invoke('sftp-download', projectPath, options)
});
