// Client for the dashboard port: skills / profiles / model management routes
// plus our own /api/mo/* extension routes (memory specimens, trajectories,
// evolution stats). Dashboard auth uses a per-boot session token injected into
// the dashboard HTML — we scrape it once and cache it per port.

import { getBaseUrl } from "./api";

let tokenCache: { port: number; token: string } | null = null;

async function getDashToken(port: number): Promise<string> {
  if (tokenCache && tokenCache.port === port) return tokenCache.token;
  // Preferred: token pre-set by the Electron main process via env + IPC
  try {
    const t = await (window as any).moAPI?.getDashToken?.();
    if (typeof t === "string" && t) { tokenCache = { port, token: t }; return t; }
  } catch { /* IPC unavailable */ }
  // Fallback (browser dev): scrape the token injected into the dashboard HTML
  const res = await fetch(`${getBaseUrl(port)}/`);
  const html = await res.text();
  const m = html.match(/__HERMES_SESSION_TOKEN__="([^"]+)"/);
  if (!m) throw new Error("dashboard token not found");
  tokenCache = { port, token: m[1] };
  return m[1];
}

export async function moFetch<T = any>(port: number, path: string, init?: RequestInit): Promise<T> {
  const token = await getDashToken(port);
  const res = await fetch(`${getBaseUrl(port)}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) { tokenCache = null; throw new Error("HTTP 401"); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ---------- skills ----------
export type Skill = { name: string; description: string; category: string; enabled: boolean };
export const listSkills = (port: number) => moFetch<Skill[]>(port, "/api/skills");
export const toggleSkill = (port: number, name: string, enabled: boolean) =>
  moFetch(port, "/api/skills/toggle", { method: "PUT", body: JSON.stringify({ name, enabled }) });
export const hubSearch = (port: number, q: string) =>
  moFetch<any>(port, `/api/skills/hub-search?query=${encodeURIComponent(q)}`);

// ---------- profiles ----------
export type Profile = {
  name: string;
  path: string;
  is_default: boolean;
  model: string | null;
  provider: string | null;
};
export const listProfiles = (port: number) =>
  moFetch<{ profiles: Profile[]; selected?: string }>(port, "/api/profiles");
export const createProfile = (port: number, name: string) =>
  moFetch(port, "/api/profiles", { method: "POST", body: JSON.stringify({ name }) });
export const deleteProfile = (port: number, name: string) =>
  moFetch(port, `/api/profiles/${encodeURIComponent(name)}`, { method: "DELETE" });
export const selectProfile = (port: number, name: string) =>
  moFetch(port, "/api/profiles/session/select", { method: "POST", body: JSON.stringify({ name }) });

// ---------- models / providers ----------
export type ModelInfo = { model: string; provider: string };
export const getModelInfo = (port: number) => moFetch<ModelInfo>(port, "/api/model/info");
export const getModelOptions = (port: number) => moFetch<any>(port, "/api/model/options");
export const getProviders = (port: number) => moFetch<any>(port, "/api/providers");
export const setModel = (port: number, model: string, provider: string) =>
  moFetch(port, "/api/model/set", {
    method: "POST",
    body: JSON.stringify({ scope: "main", model, provider }),
  });

// ---------- env / API key ----------
export const saveEnvVar = (port: number, key: string, value: string) =>
  moFetch(port, "/api/env", { method: "PUT", body: JSON.stringify({ key, value }) });
export const testApiKey = (port: number, provider: string, value: string) =>
  moFetch<{ ok: boolean; reachable: boolean; message: string }>(port, "/api/mo/test-key", {
    method: "POST",
    body: JSON.stringify({ provider, value }),
  });
export const restartGateway = (port: number) =>
  moFetch(port, "/api/gateway/restart", { method: "POST" });

// ---------- mo extension: memory specimens ----------
export type Specimen = {
  id: string;
  uri?: string;
  text: string;
  source: string;
  strength: number;
  created_at: number;
};
export type MemoryStatus = { backend: "openviking" | "local"; ready: boolean; endpoint: string | null };
export const listSpecimens = (port: number) => moFetch<{ data: Specimen[] }>(port, "/api/mo/memory");
export const searchMemory = (port: number, q: string) =>
  moFetch<{ data: Specimen[] }>(port, `/api/mo/memory/search?q=${encodeURIComponent(q)}`);
export const memoryStatus = (port: number) => moFetch<MemoryStatus>(port, "/api/mo/memory/status");
export const addSpecimen = (port: number, text: string, source = "preferences") =>
  moFetch<{ data: Specimen }>(port, "/api/mo/memory", { method: "POST", body: JSON.stringify({ text, source }) });
export const strengthenSpecimen = (port: number, id: string) =>
  moFetch(port, `/api/mo/memory/${encodeURIComponent(id)}/strengthen`, { method: "POST" });
export const forgetSpecimen = (port: number, id: string) =>
  moFetch(port, `/api/mo/memory/${encodeURIComponent(id)}`, { method: "DELETE" });
export const commitSession = (port: number, sessionId: string) =>
  moFetch(port, `/api/mo/sessions/${encodeURIComponent(sessionId)}/commit`, { method: "POST" });

// ---------- mo extension: trajectories & evolution ----------
export type Trajectory = {
  id: string;
  prompt: string;
  reply: string;
  model: string;
  duration_ms: number;
  label: "pos" | "neg" | null;
  created_at: number;
};
export type EvolutionStats = {
  task_count: number;
  specimen_count: number;
  labeled_pos: number;
  labeled_neg: number;
  success_rate: number | null;
  molting_count: number;
  last_molting: { at: number; note: string } | null;
};
export const recordTrajectory = (
  port: number,
  t: { prompt: string; reply: string; model: string; duration_ms: number; session_id?: string | null },
) => moFetch<{ count: number; turns: number }>(port, "/api/mo/trajectories", { method: "POST", body: JSON.stringify(t) });
export const listTrajectories = (port: number, limit = 20) =>
  moFetch<{ data: Trajectory[] }>(port, `/api/mo/trajectories?limit=${limit}`);
export const labelTrajectory = (port: number, id: string, label: "pos" | "neg") =>
  moFetch(port, `/api/mo/trajectories/${encodeURIComponent(id)}/label`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
export const getEvolutionStats = (port: number) => moFetch<EvolutionStats>(port, "/api/mo/evolution/stats");
export const scheduleMolting = (port: number, note: string) =>
  moFetch(port, "/api/mo/moltings", { method: "POST", body: JSON.stringify({ note }) });

// ---------- mo extension: Harness self-evolution (skills via GEPA) ----------
export type EvolveStatus = { ready: boolean; reason: string; profile: string; optimizer_model: string; eval_model: string };
export type EvolveSkill = { name: string; description: string; size: number; path: string; builtin: boolean };
export type EvolveRun = {
  id: string; skill: string; iterations: number; eval_source: string;
  status: "running" | "done" | "failed" | "accepted" | "rejected";
  created_at: number; finished_at?: number; error?: string;
  opt_model?: string; eval_model?: string; applied_to?: string;
};
export type EvolveRunDetail = EvolveRun & {
  baseline?: string; evolved?: string; diff?: string;
  metrics?: { baseline_score?: number; evolved_score?: number; improvement?: number; baseline_size?: number; evolved_size?: number };
};
export type EvolveSchedule = { enabled: boolean; hour: number; minute: number; skill: string; iterations: number };

export const getEvolveStatus = (port: number) => moFetch<EvolveStatus>(port, "/api/mo/evolve/status");
export const listEvolveSkills = (port: number) => moFetch<{ data: EvolveSkill[] }>(port, "/api/mo/evolve/skills");
export const runEvolve = (port: number, skill: string, iterations: number, eval_source = "synthetic") =>
  moFetch<{ ok: boolean; run_id?: string; reason?: string }>(port, "/api/mo/evolve/run", {
    method: "POST", body: JSON.stringify({ skill, iterations, eval_source }),
  });
export const listEvolveRuns = (port: number) => moFetch<{ data: EvolveRun[] }>(port, "/api/mo/evolve/runs");
export const getEvolveRun = (port: number, id: string) => moFetch<EvolveRunDetail>(port, `/api/mo/evolve/runs/${encodeURIComponent(id)}`);
export const acceptEvolveRun = (port: number, id: string) =>
  moFetch(port, `/api/mo/evolve/runs/${encodeURIComponent(id)}/accept`, { method: "POST" });
export const rejectEvolveRun = (port: number, id: string) =>
  moFetch(port, `/api/mo/evolve/runs/${encodeURIComponent(id)}/reject`, { method: "POST" });
export const getEvolveRunLog = (port: number, id: string, tail = 400) =>
  moFetch<{ data: string; exists: boolean; total_lines?: number; error?: string }>(
    port, `/api/mo/evolve/runs/${encodeURIComponent(id)}/log?tail=${tail}`);
// ---------- mo extension: local models (Ollama) ----------
export type LocalStatus = { installed: boolean; running: boolean; endpoint: string; local_active: boolean; current_model: string; current_provider: string };
export type LocalModel = { name: string; size: number };
export const getLocalStatus = (port: number) => moFetch<LocalStatus>(port, "/api/mo/local/status");
export const listLocalModels = (port: number) => moFetch<{ data: LocalModel[] }>(port, "/api/mo/local/models");
export const pullLocalModel = (port: number, model: string) =>
  moFetch<{ ok: boolean; reason?: string }>(port, "/api/mo/local/pull", { method: "POST", body: JSON.stringify({ model }) });
export const useLocalModel = (port: number, model: string) =>
  moFetch<{ ok: boolean; model: string; note?: string }>(port, "/api/mo/local/use", { method: "POST", body: JSON.stringify({ model }) });

// ---------- mo extension: model fine-tuning ----------
export type FinetuneConfig = { train_path: string; test_path: string; train_rows: number; test_rows: number; min_train_rows: number; datasets_ready: boolean; mint_api_key_set: boolean };
export type FinetuneStatus = {
  datasets_ready: boolean; train_rows: number; test_rows: number; min_train_rows: number;
  local_active: boolean; current_model: string; backend: string; backend_reason: string;
  mode: "real" | "scaffold"; mint_api_key_set: boolean; can_start: boolean;
};
export type FinetuneRun = { id: string; method: string; steps: number; base_model: string; status: string; created_at: number; finished_at?: number; mode?: string; scaffold?: boolean; error?: string };
export const getFinetuneConfig = (port: number) => moFetch<FinetuneConfig>(port, "/api/mo/finetune/config");
export const setFinetuneConfig = (port: number, patch: Partial<{ train_path: string; test_path: string; mint_api_key: string }>) =>
  moFetch<FinetuneConfig>(port, "/api/mo/finetune/config", { method: "PUT", body: JSON.stringify(patch) });
export const genFinetuneDataset = (port: number) =>
  moFetch<{ ok: boolean; reason?: string; train_rows: number; test_rows: number; train_path?: string; test_path?: string }>(port, "/api/mo/finetune/gen-dataset", { method: "POST" });
export const getFinetuneStatus = (port: number) => moFetch<FinetuneStatus>(port, "/api/mo/finetune/status");
export const runFinetune = (port: number, method: string, steps: number, base_model?: string) =>
  moFetch<{ ok: boolean; run_id?: string; reason?: string }>(port, "/api/mo/finetune/run", { method: "POST", body: JSON.stringify({ method, steps, base_model }) });
export const listFinetuneRuns = (port: number) => moFetch<{ data: FinetuneRun[] }>(port, "/api/mo/finetune/runs");
export const getFinetuneRunLog = (port: number, id: string, tail = 400) =>
  moFetch<{ data: string; exists: boolean; total_lines?: number }>(port, `/api/mo/finetune/runs/${encodeURIComponent(id)}/log?tail=${tail}`);

// ---------- mo extension: endpoint library + model selection ----------
export type Endpoint = { id: string; name: string; base_url: string; models: string[]; api_key_set: boolean };
export const listEndpoints = (port: number) => moFetch<{ data: Endpoint[] }>(port, "/api/mo/endpoints");
export const addEndpoint = (port: number, e: { name: string; base_url: string; api_key: string; models?: string[] }) =>
  moFetch<{ data: Endpoint[] }>(port, "/api/mo/endpoints", { method: "POST", body: JSON.stringify(e) });
export const updateEndpoint = (port: number, id: string, patch: Partial<{ name: string; base_url: string; api_key: string; models: string[] }>) =>
  moFetch<{ data: Endpoint[] }>(port, `/api/mo/endpoints/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) });
export const deleteEndpoint = (port: number, id: string) =>
  moFetch<{ data: Endpoint[] }>(port, `/api/mo/endpoints/${encodeURIComponent(id)}`, { method: "DELETE" });
export const detectEndpointModels = (port: number, id: string) =>
  moFetch<{ ok: boolean; models?: string[]; reason?: string }>(port, `/api/mo/endpoints/${encodeURIComponent(id)}/detect`, { method: "POST" });

export type EmbeddingSel = { endpoint_id: string; model: string; vlm_model: string; dimension: number; endpoints: Endpoint[]; note?: string };
export type EvolveSel = { endpoint_id: string; optimizer_model: string; eval_model: string; endpoints: Endpoint[] };
export const getEmbeddingConfig = (port: number) => moFetch<EmbeddingSel>(port, "/api/mo/models/embedding");
export const setEmbeddingConfig = (port: number, patch: { endpoint_id: string; model: string; vlm_model?: string; dimension?: number }) =>
  moFetch<EmbeddingSel>(port, "/api/mo/models/embedding", { method: "PUT", body: JSON.stringify(patch) });
export const getEvolveModelConfig = (port: number) => moFetch<EvolveSel>(port, "/api/mo/models/evolve");
export const setEvolveModelConfig = (port: number, patch: Partial<{ endpoint_id: string; optimizer_model: string; eval_model: string }>) =>
  moFetch<EvolveSel>(port, "/api/mo/models/evolve", { method: "PUT", body: JSON.stringify(patch) });

export const getEvolveSchedule = (port: number) => moFetch<EvolveSchedule>(port, "/api/mo/evolve/schedule");
export const setEvolveSchedule = (port: number, s: EvolveSchedule) =>
  moFetch(port, "/api/mo/evolve/schedule", { method: "PUT", body: JSON.stringify(s) });
