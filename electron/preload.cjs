const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pinkroseDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  getStorageInfo: () => ipcRenderer.invoke('desktop:get-storage-info'),
  openStorageFolder: () => ipcRenderer.invoke('desktop:open-storage-folder'),
  chooseStorageFolder: () => ipcRenderer.invoke('desktop:choose-storage-folder'),
}))
