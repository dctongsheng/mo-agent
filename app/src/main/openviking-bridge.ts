// Spawns the OpenViking context-database server (the memory backend) and
// scaffolds its config. Everything here is best-effort: if OpenViking can't
// start (not installed, no embedding model configured, port busy) the desktop
// app still runs and the memory UI falls back to the local JSON store.

import { ChildProcess, execFile, spawn } from "child_process";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { resolveHermesHome } from "./python-bridge";

const OV_DEFAULT_PORT = 1933;

export interface OpenVikingHandle {
  process: ChildProcess | null;
  port: number | null;
  endpoint: string | null;
  kill: () => void;
}

function ovHome(): string {
  return path.join(process.env.HOME ?? "", ".openviking");
}

function ovPidFile(): string {
  return path.join(resolveHermesHome(), "openviking.pid");
}

/** Kill an orphaned openviking-server from a previous crashed run. */
export function killOrphanOpenViking(): void {
  try {
    const pid = parseInt(fs.readFileSync(ovPidFile(), "utf-8").trim(), 10);
    if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    fs.unlinkSync(ovPidFile());
  } catch { /* no pid file */ }
}

/** Locate the openviking-server executable. Returns null if not installed. */
function findServerBin(): string | null {
  const candidates = [
    path.join(process.env.HOME ?? "", ".hermes", "hermes-agent", "venv", "bin", "openviking-server"),
    path.resolve(__dirname, "..", "..", "..", "desktop", "build", "hermes-venv", "bin", "openviking-server"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Write ~/.openviking/ov.conf with a workspace and *blank* embedding/VLM
 * sections for the user to fill. Never overwrites an existing file.
 */
export function scaffoldOvConf(): void {
  const home = ovHome();
  const conf = path.join(home, "ov.conf");
  if (fs.existsSync(conf)) return;
  fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
  // OpenViking needs an embedding model AND a VLM to run. DeepSeek has no
  // embeddings, so point these at an OpenAI-compatible gateway that does.
  // provider "openai" + api_base works for any OpenAI-compatible endpoint;
  // encoding_format "float" avoids base64 payload issues some gateways have.
  // Fill api_base / api_key / model, then restart the app.
  const template = {
    storage: { workspace: path.join(home, "workspace") },
    embedding: {
      dense: {
        provider: "openai",
        api_base: "",
        api_key: "",
        model: "",
        dimension: 1024,
        encoding_format: "float",
      },
      max_concurrent: 10,
    },
    vlm: { provider: "openai", api_base: "", api_key: "", model: "", max_concurrent: 16 },
  };
  try {
    fs.writeFileSync(conf, JSON.stringify(template, null, 2), "utf-8");
  } catch { /* non-fatal */ }
}

/**
 * Ensure the mo Hermes home is configured to use the OpenViking memory
 * provider: `memory.provider: openviking` in config.yaml and OPENVIKING_*
 * vars in .env. Idempotent — only writes when values are missing/different.
 */
export function bootstrapMemoryConfig(endpoint: string): void {
  const home = resolveHermesHome();
  fs.mkdirSync(home, { recursive: true });

  // --- .env ---
  const envPath = path.join(home, ".env");
  let envText = "";
  try { envText = fs.readFileSync(envPath, "utf-8"); } catch { /* new file */ }
  const ensureEnv = (key: string, value: string) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(envText)) {
      envText = envText.replace(re, `${key}=${value}`);
    } else {
      if (envText && !envText.endsWith("\n")) envText += "\n";
      envText += `${key}=${value}\n`;
    }
  };
  ensureEnv("OPENVIKING_ENDPOINT", endpoint);
  ensureEnv("OPENVIKING_ACCOUNT", "default");
  ensureEnv("OPENVIKING_USER", "default");
  ensureEnv("OPENVIKING_AGENT", "hermes");
  try { fs.writeFileSync(envPath, envText, "utf-8"); } catch { /* non-fatal */ }

  // --- config.yaml: set memory.provider: openviking (line-based, no yaml dep) ---
  const cfgPath = path.join(home, "config.yaml");
  let cfg = "";
  try { cfg = fs.readFileSync(cfgPath, "utf-8"); } catch { return; }
  // Match `provider: ...` indented under the `memory:` block.
  const memBlock = /(^memory:\s*$[\s\S]*?)(^\S)/m;
  if (/^memory:\s*$/m.test(cfg)) {
    const providerLine = /^(\s+)provider:.*$/m;
    // Only replace a provider line that lives inside the memory block.
    const lines = cfg.split("\n");
    let inMem = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^memory:\s*$/.test(lines[i])) { inMem = true; continue; }
      if (inMem && /^\S/.test(lines[i])) inMem = false;
      if (inMem && /^\s+provider:/.test(lines[i])) {
        lines[i] = lines[i].replace(/provider:.*/, "provider: openviking");
        break;
      }
    }
    cfg = lines.join("\n");
    try { fs.writeFileSync(cfgPath, cfg, "utf-8"); } catch { /* non-fatal */ }
  }
  void memBlock;
}

function pollHealth(port: number, deadlineMs: number, isDead: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + deadlineMs;
    const tick = () => {
      // Bail immediately if the server process already exited (e.g. blank
      // ov.conf → "Embedding model name is required" → instant exit). Avoids
      // stalling startup for the full deadline polling a dead port.
      if (isDead()) { resolve(false); return; }
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) { resolve(true); return; }
        if (Date.now() > deadline || isDead()) { resolve(false); return; }
        setTimeout(tick, 1000);
      });
      req.on("error", () => {
        if (Date.now() > deadline || isDead()) { resolve(false); return; }
        setTimeout(tick, 1000);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

/** Discover the port the server actually bound (defaults to 1933). */
function discoverPort(pid: number, fallback: number): Promise<number> {
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n"], (err, stdout) => {
      if (!err && stdout) {
        const m = stdout.match(/:(\d+)\s+\(LISTEN\)/);
        if (m) { resolve(parseInt(m[1], 10)); return; }
      }
      resolve(fallback);
    });
  });
}

/**
 * Best-effort start of the OpenViking server. Resolves with a handle whose
 * `endpoint` is non-null only if the server became healthy. Never throws.
 */
export async function startOpenViking(): Promise<OpenVikingHandle> {
  const noop: OpenVikingHandle = { process: null, port: null, endpoint: null, kill: () => {} };

  scaffoldOvConf();
  killOrphanOpenViking();

  const bin = findServerBin();
  if (!bin) {
    console.warn("[openviking] server binary not found — memory backend disabled");
    return noop;
  }

  const confPath = path.join(ovHome(), "ov.conf");
  let child: ChildProcess;
  try {
    child = spawn(bin, ["--host", "127.0.0.1", "--port", String(OV_DEFAULT_PORT), "--config", confPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (e) {
    console.warn("[openviking] spawn failed:", e);
    return noop;
  }

  let exited = false;
  try { fs.writeFileSync(ovPidFile(), String(child.pid)); } catch { /* non-fatal */ }
  child.on("exit", () => { exited = true; try { fs.unlinkSync(ovPidFile()); } catch { /* gone */ } });

  const kill = () => { try { child.kill("SIGKILL"); } catch { /* dead */ } };

  if (child.pid == null) return noop;
  const port = await discoverPort(child.pid, OV_DEFAULT_PORT);
  const healthy = await pollHealth(port, 30_000, () => exited);
  if (!healthy) {
    console.warn(`[openviking] server on :${port} did not become healthy — memory backend degraded`);
    // Leave it running; it may still come up. But report no endpoint so the
    // gateway falls back to local JSON until /health passes.
    return { process: child, port, endpoint: null, kill };
  }

  console.log(`[openviking] server healthy on :${port}`);
  return { process: child, port, endpoint: `http://127.0.0.1:${port}`, kill };
}
