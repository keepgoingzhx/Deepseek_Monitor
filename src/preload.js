const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deepseekMonitor", {
  getSnapshot: () => ipcRenderer.invoke("app:getSnapshot"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  refreshBalance: () => ipcRenderer.invoke("balance:refresh"),
  importCsv: () => ipcRenderer.invoke("usage:importCsv"),
  openUsagePage: () => ipcRenderer.invoke("usage:openUsagePage"),
  syncUsagePage: () => ipcRenderer.invoke("usage:syncUsagePage"),
  autoExport: () => ipcRenderer.invoke("usage:autoExport"),
  startAutoScrape: () => ipcRenderer.invoke("usage:startAutoScrape"),
  resetUsage: () => ipcRenderer.invoke("usage:reset"),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  setCompactMode: (compactMode) => ipcRenderer.invoke("window:setCompactMode", compactMode),
  close: () => ipcRenderer.invoke("window:close"),
  onSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("snapshot:update", listener);
    return () => ipcRenderer.removeListener("snapshot:update", listener);
  }
});
