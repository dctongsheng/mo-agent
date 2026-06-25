// Spawns the shared desktop-gateway.py (full Hermes gateway + web dashboard)
// and discovers its two listening ports by scanning the child process's
// actual TCP sockets — the ports printed to stdout are not reliable.

import { ChildProcess, execFile, spawn } from "child_process";
import * as crypto from "crypto";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { app } from "electron";

// Pre-set dashboard session token so the renderer can authenticate against
// the dashboard's /api/* routes without scraping the HTML.
export const DASHBOARD_TOKEN = crypto.randomBytes(24).toString("base64url");

export const RESTART_EXIT_CODE = 75;

export interface GatewayPorts {
  /** OpenAI-compatible API server: /v1/chat/completions, /api/sessions */
  api: number;
  /** Web dashboard: /api/skills, /api/profiles, /api/model/*, /api/mo/* */
  mo: number | null;
}

export interface PythonBridge {
  process: ChildProcess;
  ports: GatewayPorts;
  kill: () => void;
  killAndWait: () => Promise<void>;
  onRestartExit: (cb: () => void) => void;
}

function getHermesAgentRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "hermes-agent");
  }
  // Dev: vendored Hermes core lives at <repo>/vendor/hermes-agent.
  // __dirname is <repo>/app/dist/main → up 3 is the repo root.
  return path.resolve(__dirname, "..", "..", "..", "vendor", "hermes-agent");
}

function getPythonPath(): string {
  // Prefer a virtualenv next to the vendored core, then a repo-level .venv,
  // then a developer's locally installed Hermes venv, finally the system python.
  const candidates = [
    path.join(getHermesAgentRoot(), ".venv", "bin", "python3"),
    path.resolve(__dirname, "..", "..", "..", ".venv", "bin", "python3"),
    path.join(process.env.HOME ?? "", ".hermes", "hermes-agent", "venv", "bin", "python"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "python3";
}

export function resolveHermesHome(): string {
  if (app.isPackaged) {
    return path.join(app.getPath("userData"), "hermes");
  }
  // Dev: dedicated home so we never conflict with the user's main Hermes
  // (~/.hermes/.env pins API_SERVER_PORT=8644 → port-in-use errors)
  return path.join(process.env.HOME ?? "", ".hermes-mo");
}

/** Read API_SERVER_KEY from the hermes home .env (sent to renderer via IPC). */
export function readApiServerKey(): string {
  try {
    const envFile = fs.readFileSync(path.join(resolveHermesHome(), ".env"), "utf-8");
    const m = envFile.match(/^API_SERVER_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* no .env */ }
  return process.env.API_SERVER_KEY ?? "";
}

function getServerScript(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "python-server", "mo-gateway.py");
  }
  // Dev: <repo>/server/mo-gateway.py (__dirname is <repo>/app/dist/main).
  return path.resolve(__dirname, "..", "..", "..", "server", "mo-gateway.py");
}

const PID_FILE = () => path.join(resolveHermesHome(), "gateway.pid");

/** Kill an orphaned gateway from a previous crashed run (recorded in our pid file). */
export function killOrphanGateway(): void {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE(), "utf-8").trim(), 10);
    if (pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    fs.unlinkSync(PID_FILE());
  } catch { /* no pid file */ }
}

function classify(port: number, cb: (kind: "api" | "mo" | null) => void): void {
  const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
    let body = "";
    res.on("data", (c) => { body += c; });
    res.on("end", () => {
      if (res.statusCode !== 200) { cb(null); return; }
      if (body.includes("hermes-agent")) cb("api");
      else if (body.includes("HERMES_SESSION_TOKEN") || body.includes("<!doctype")) cb("mo");
      else cb(null);
    });
  });
  req.on("error", () => cb(null));
  req.setTimeout(2000, () => req.destroy());
}

export async function startPythonBackend(ovEndpoint?: string | null): Promise<PythonBridge> {
  const pythonPath = getPythonPath();
  const serverScript = getServerScript();
  const hermesRoot = getHermesAgentRoot();
  const hermesHome = resolveHermesHome();

  killOrphanGateway();

  fs.mkdirSync(path.join(hermesHome, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(hermesHome, "memory"), { recursive: true });
  fs.mkdirSync(path.join(hermesHome, "trajectories"), { recursive: true });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HERMES_HOME: hermesHome,
    HERMES_AGENT_ROOT: hermesRoot,
    PYTHONDONTWRITEBYTECODE: "1",
    HERMES_DESKTOP_MODE: "1",
    HERMES_DASHBOARD_SESSION_TOKEN: DASHBOARD_TOKEN,
    // Skip semantic memory recall for messages shorter than this many chars
    // (bare greetings like "你好" gain nothing from a vector search). Set to
    // "0" to always recall. Honored by the gateway's recall-skip patch.
    MO_RECALL_MIN_CHARS: "6",
  };
  // When the OpenViking memory server is up, point the gateway (and the
  // openviking memory plugin it loads) at it. Absent this var, the plugin's
  // is_available() returns false and Hermes uses only built-in memory.
  if (ovEndpoint) env.OPENVIKING_ENDPOINT = ovEndpoint;

  const child = spawn(pythonPath, [serverScript], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: hermesRoot,
  });

  try { fs.writeFileSync(PID_FILE(), String(child.pid)); } catch { /* non-fatal */ }

  let restartCb: (() => void) | null = null;
  child.on("exit", (code) => {
    try { fs.unlinkSync(PID_FILE()); } catch { /* gone */ }
    if (code === RESTART_EXIT_CODE && restartCb) restartCb();
  });

  // Scan the child's listening TCP ports every second; classify each as the
  // API server or the dashboard. Resolve as soon as the API port is verified
  // (the dashboard port keeps being filled in afterwards if it shows up later).
  const ports: GatewayPorts = { api: 0, mo: null };
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error("Gateway did not start within 150s")); }, 150_000);
    let stderr = "";
    let settled = false;
    const seen = new Set<number>();
    let scanTimer: ReturnType<typeof setTimeout> | null = null;
    let stopScanning = false;

    const stop = () => { stopScanning = true; if (scanTimer) clearTimeout(scanTimer); };

    const scan = () => {
      if (stopScanning || child.pid == null) return;
      execFile("lsof", ["-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n"], (err, stdout) => {
        if (!stopScanning && !err && stdout) {
          for (const m of stdout.matchAll(/:(\d+)\s+\(LISTEN\)/g)) {
            const port = parseInt(m[1], 10);
            if (seen.has(port)) continue;
            seen.add(port);
            classify(port, (kind) => {
              if (kind === "api" && !ports.api) {
                ports.api = port;
                if (!settled) { settled = true; clearTimeout(timeout); resolve(); }
              } else if (kind === "mo" && ports.mo == null) {
                ports.mo = port;
              } else if (kind === null) {
                seen.delete(port); // retry later — server may not be ready yet
              }
              // Stop scanning once both ports are known
              if (ports.api && ports.mo != null) stop();
            });
          }
        }
        if (!stopScanning) scanTimer = setTimeout(scan, 1000);
      });
    };
    scanTimer = setTimeout(scan, 1000);

    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });

    child.on("error", (err) => { if (!settled) { stop(); clearTimeout(timeout); reject(err); } });
    child.on("exit", (code) => {
      if (!settled) {
        stop();
        clearTimeout(timeout);
        reject(new Error(`Python exited ${code}. ${stderr.slice(-1024)}`));
      }
    });
  });

  const kill = () => {
    restartCb = null;
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  };

  const killAndWait = (): Promise<void> => new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once("exit", () => resolve());
    const t = setTimeout(resolve, 1500);
    (t as any).unref?.();
    kill();
  });

  return {
    process: child,
    ports,
    kill,
    killAndWait,
    onRestartExit: (cb) => { restartCb = cb; },
  };
}
