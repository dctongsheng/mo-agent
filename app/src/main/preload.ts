import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("moAPI", {
  getPorts: () => ipcRenderer.invoke("get-ports"),
  getPort: () => ipcRenderer.invoke("get-port"),
  getApiKey: () => ipcRenderer.invoke("get-api-key"),
  getDashToken: () => ipcRenderer.invoke("get-dash-token"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  onPythonReady: (cb: (ports: { api: number; mo: number | null }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ports: { api: number; mo: number | null }) => cb(ports);
    ipcRenderer.on("python-ready", listener);
    return () => ipcRenderer.removeListener("python-ready", listener);
  },
  onPythonRestarting: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("python-restarting", listener);
    return () => ipcRenderer.removeListener("python-restarting", listener);
  },
  onPythonError: (cb: (err: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, err: string) => cb(err);
    ipcRenderer.on("python-error", listener);
    return () => ipcRenderer.removeListener("python-error", listener);
  },
});
