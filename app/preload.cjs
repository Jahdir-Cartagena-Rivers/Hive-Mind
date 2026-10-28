// The renderer never sees the service token: every call goes through the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hive", {
  request: (route, body) => ipcRenderer.invoke("hive:request", route, body),
  pickFolder: () => ipcRenderer.invoke("hive:pick-folder"),
  openVault: () => ipcRenderer.invoke("hive:open-vault"),
  connection: () => ipcRenderer.invoke("hive:connection"),
  copyToken: () => ipcRenderer.invoke("hive:copy-token"),
  exportPlugin: (options) => ipcRenderer.invoke("hive:export-plugin", options),
  checkConnector: () => ipcRenderer.invoke("hive:check-connector"),
  loginItem: (enabled) => ipcRenderer.invoke("hive:login-item", enabled),
  importImage: (metadata) => ipcRenderer.invoke("hive:import-image", metadata),
  importFile: (metadata) => ipcRenderer.invoke("hive:import-file", metadata),
  saveReference: (id) => ipcRenderer.invoke("hive:save-reference", id),
  assetData: (id) => ipcRenderer.invoke("hive:asset-data", id),
  assetPreview: (id) => ipcRenderer.invoke("hive:asset-preview", id),
  archive: (action) => ipcRenderer.invoke("hive:archive", action),
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("hive:changed", listener);
    return () => ipcRenderer.removeListener("hive:changed", listener);
  },
});
