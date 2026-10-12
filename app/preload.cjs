// The renderer never sees the service token: every call goes through the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hive", {
  request: (route, body) => ipcRenderer.invoke("hive:request", route, body),
  pickFolder: () => ipcRenderer.invoke("hive:pick-folder"),
  openVault: () => ipcRenderer.invoke("hive:open-vault"),
  connection: () => ipcRenderer.invoke("hive:connection"),
  copyToken: () => ipcRenderer.invoke("hive:copy-token"),
  loginItem: (enabled) => ipcRenderer.invoke("hive:login-item", enabled),
});
