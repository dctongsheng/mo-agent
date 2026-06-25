import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { startPythonBackend, readApiServerKey, DASHBOARD_TOKEN, PythonBridge, GatewayPorts } from "./python-bridge";
import { startOpenViking, bootstrapMemoryConfig, OpenVikingHandle } from "./openviking-bridge";

const DEBUG_LOG = path.join(os.tmpdir(), "mo-debug.log");
function dlog(msg: string): void {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}

app.setPath("userData", path.join(app.getPath("appData"), "ai.taiyi.mo"));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let pythonBridge: PythonBridge | null = null;
let backendPorts: GatewayPorts | null = null;
let openViking: OpenVikingHandle | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f5efe0", // rice paper — avoid flash before CSS loads
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const rendererDist = path.join(__dirname, "..", "..", "src", "renderer", "dist");
  const rendererDev = path.join(__dirname, "..", "..", "src", "renderer", "index.html");

  if (fs.existsSync(rendererDist + "/index.html")) {
    mainWindow.loadFile(path.join(rendererDist, "index.html"));
  } else {
    mainWindow.loadFile(rendererDev);
  }
}

app.whenReady().then(async () => {
  dlog("app ready, creating window");
  createWindow();

  // Boot the OpenViking memory server first (best-effort, non-blocking on
  // failure). Its endpoint is injected into the gateway so the Hermes
  // openviking memory plugin activates.
  //
  // The config is wired to OpenViking *deterministically* — independent of
  // whether the server is healthy on this boot. With a blank ov.conf the
  // server won't start, but both the gateway (_ov_healthy) and the plugin
  // (initialize → health check) degrade gracefully to local memory. Writing
  // the config now means the moment the user fills in an embedding model and
  // restarts, everything lights up with no further setup.
  let ovEndpoint = "http://127.0.0.1:1933";
  try {
    dlog("starting openviking memory server...");
    openViking = await startOpenViking();
    if (openViking.port) ovEndpoint = `http://127.0.0.1:${openViking.port}`;
    dlog(`openviking: ${openViking.endpoint ? `healthy ${openViking.endpoint}` : `degraded (endpoint ${ovEndpoint})`}`);
  } catch (err) {
    dlog(`openviking start error (continuing): ${String(err)}`);
  }
  try { bootstrapMemoryConfig(ovEndpoint); } catch (err) { dlog(`memory config bootstrap error: ${String(err)}`); }

  // Boot the Hermes Core Python backend
  try {
    dlog("starting python backend...");
    pythonBridge = await startPythonBackend(ovEndpoint);
    backendPorts = pythonBridge.ports;
    dlog(`python backend verified: api=${backendPorts.api} mo=${backendPorts.mo}`);
    mainWindow?.webContents.send("python-ready", backendPorts);

    pythonBridge.onRestartExit(() => {
      mainWindow?.webContents.send("python-restarting");
      backendPorts = null;
      startPythonBackend(ovEndpoint).then((bridge) => {
        pythonBridge = bridge;
        backendPorts = bridge.ports;
        dlog(`python backend restarted: api=${backendPorts.api} mo=${backendPorts.mo}`);
        mainWindow?.webContents.send("python-ready", backendPorts);
      }).catch((err) => {
        dlog(`python restart FAILED: ${String(err)}`);
        mainWindow?.webContents.send("python-error", String(err));
      });
    });
  } catch (err) {
    dlog(`python backend FAILED: ${String(err)}`);
    mainWindow?.webContents.send("python-error", String(err));
  }
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("before-quit", () => {
  pythonBridge?.kill();
  openViking?.kill();
});

app.on("window-all-closed", () => {
  // Quit on all platforms — keeping the app alive without a window would
  // leave the Python gateway / OpenViking server orphaned.
  pythonBridge?.kill();
  openViking?.kill();
  app.quit();
});

process.on("exit", () => {
  try { pythonBridge?.kill(); } catch { /* dying anyway */ }
  try { openViking?.kill(); } catch { /* dying anyway */ }
});

// IPC handlers
ipcMain.handle("get-ports", () => backendPorts);
ipcMain.handle("get-port", () => backendPorts?.api ?? null); // back-compat
ipcMain.handle("get-api-key", () => readApiServerKey());
ipcMain.handle("get-dash-token", () => DASHBOARD_TOKEN);
ipcMain.handle("open-external", (_e, url: string) => {
  // Only allow web links — never file:// or custom protocols from the renderer
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  return Promise.resolve();
});
ipcMain.handle("get-app-version", () => app.getVersion());
