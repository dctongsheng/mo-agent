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

/** Authenticated fetch that hands back the raw Response, so a caller can treat
 *  a specific status as data rather than an error (the accept route answers 409
 *  with a gate verdict the user needs to see). */
export async function moFetchRaw(port: number, path: string, init?: RequestInit): Promise<Response> {
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
  return res;
}

export async function moFetch<T = any>(port: number, path: string, init?: RequestInit): Promise<T> {
  const res = await moFetchRaw(port, path, init);
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
export type PendingChange = { skill: string; version?: number; at: number; kind?: string };
export type EvolveStatus = {
  ready: boolean; reason: string; profile: string;
  optimizer_model: string; eval_model: string;
  /** Skills written to disk that the running gateway hasn't picked up yet. */
  pending?: PendingChange[];
};
export type EvolveSkill = { name: string; description: string; size: number; path: string; builtin: boolean };
export type EvolveRun = {
  id: string; skill: string; iterations: number; eval_source: string;
  status: "running" | "done" | "failed" | "accepted" | "rejected";
  created_at: number; finished_at?: number; error?: string;
  opt_model?: string; eval_model?: string; applied_to?: string;
  /** Failed because a hard constraint rejected the candidate, not because the
   *  run crashed — the rejected text is still viewable. */
  constraints_failed?: boolean;
  /** Set when 夜貘 chose this target itself rather than by rotation. */
  plan_id?: string; why?: string;
  // Added as fields, never as new `status` values — STATUS_LABEL/STATUS_COLOR
  // render blank for unknown statuses.
  archive_version?: number; forced?: boolean; gate_passed?: boolean | null; pins?: number;
};
/** Paired-bootstrap verdict on the holdout. `passed` arms the accept button;
 *  a failing gate still allows accept, but only via an explicit force-confirm. */
export type EvolveGate = {
  passed: boolean; reason: string;
  delta: number; ci_low: number; ci_high: number; n: number;
  pin_regressions?: { task_input: string; baseline: number; evolved: number; delta: number }[];
  degraded?: boolean;
};
/** How the scores were actually produced. Before the tiered judge landed,
 *  every number the UI showed was a bag-of-words overlap wearing an
 *  "LLM-as-judge" label; `metric_mode` is what keeps that honest. */
export type EvolveFitness = {
  metric_mode?: "heuristic" | "tiered" | "judge";
  judge_model?: string;
  heuristic_calls?: number; judge_calls?: number; judge_failures?: number;
  cache_hits?: number; capped?: boolean; degraded?: boolean; collusion_risk?: boolean;
  holdout_dimensions?: {
    baseline: Record<string, number>;
    evolved: Record<string, number>;
  };
};
/** Where the eval examples came from. This is what makes a run legible:
 *  "read 6 negative trajectories, mostly about ignoring length constraints". */
export type EvolveDataset = {
  source?: string;
  counts?: { trajectory_neg?: number; trajectory_pos?: number; trajectory_unlabelled?: number; synthetic?: number };
  turns_mined?: number;
  failure_modes?: Record<string, number>;
  trajectory_ids?: string[];
  holdout_strata?: Record<string, number>;
};
export type SafetyFinding = { severity: "high" | "medium"; pattern: string; line: string; why: string };
export type EvolveRunDetail = EvolveRun & {
  baseline?: string; evolved?: string; diff?: string;
  metrics?: {
    baseline_score?: number; evolved_score?: number; improvement?: number;
    baseline_size?: number; evolved_size?: number; fitness?: EvolveFitness;
    dataset?: EvolveDataset;
  };
  gate?: EvolveGate | null;
  safety?: { findings?: SafetyFinding[] } | null;
  critic?: EvolveCritique | null;
  plan?: EvolutionPlan | null;
  /** Present when the candidate was rejected by the hard constraints. The
   *  evolved text shown is `evolved_FAILED.md`. */
  constraints?: { name: string; passed: boolean; message: string; details?: string }[];
  /** True when the live SKILL.md changed after this run started — accepting
   *  would discard the user's own edits. */
  stale_baseline?: boolean;
};
/** 夜貘's reasoning for a run: what it picked, why, and what it expects to
 *  happen — stated before the run so it can be checked afterwards. */
export type PredictionCheck = {
  dimension: string; direction: string; threshold: number;
  outcome?: boolean | null;
};
export type EvolutionPlan = {
  id: string; at: number; skill: string; why: string; hypothesis?: string;
  eval_source?: string; iterations?: number; model?: string; run_id?: string | null;
  prediction?: {
    statement?: string; checks?: PredictionCheck[];
    check_results?: PredictionCheck[];
    verified?: boolean | null; verified_at?: number | null;
  };
};
/** A second opinion from a model that is not the author. Advisory: a `reject`
 *  doesn't block, it just makes accepting take an explicit confirmation. */
export type EvolveCritique = {
  verdict: "accept" | "revise" | "reject";
  rationale: string; risks: string[]; model?: string;
  collusion?: boolean; skipped?: string; downgrades?: boolean;
};
/** How often 夜貘's predictions came true. This number goes DOWN when it is
 *  wrong, which is what separates reasoning from activity reporting. */
export type Calibration = {
  total: number; verified: number; unverifiable?: number;
  accuracy: number | null;
  by_skill?: Record<string, { total: number; verified: number; unverifiable: number }>;
};
export type SkillVersion = {
  version: number; at: number; run_id?: string; kind?: string;
  sha256?: string; size?: number; existed?: boolean; forced?: boolean;
};
export type EvolveSchedule = {
  enabled: boolean; hour: number; minute: number; skill: string;
  iterations: number; eval_source?: EvalSource;
  /** Let 夜貘 reason about the target instead of rotating alphabetically. */
  reflect?: boolean;
};

export const getEvolveStatus = (port: number) => moFetch<EvolveStatus>(port, "/api/mo/evolve/status");
export const listEvolveSkills = (port: number) => moFetch<{ data: EvolveSkill[] }>(port, "/api/mo/evolve/skills");
/** `mixed` mines the user's own trajectories and tops up with synthetic when
 *  too few are found — the default, because a purely synthetic eval set is
 *  synthesized from the skill's own text and the loop is self-referential. */
export type EvalSource = "mixed" | "trajectory" | "synthetic";
/** `plan_id` attaches 夜貘's reasoning (and its prediction) to the run, so the
 *  prediction actually gets scored. Without it an on-demand reflection's
 *  prediction is saved and then never checked. */
export const runEvolve = (
  port: number, skill: string, iterations: number,
  eval_source: EvalSource = "mixed", plan_id?: string,
) =>
  moFetch<{ ok: boolean; run_id?: string; reason?: string }>(port, "/api/mo/evolve/run", {
    method: "POST", body: JSON.stringify({ skill, iterations, eval_source, plan_id }),
  });
export const listEvolveRuns = (port: number) => moFetch<{ data: EvolveRun[] }>(port, "/api/mo/evolve/runs");
export const getEvolveRun = (port: number, id: string) => moFetch<EvolveRunDetail>(port, `/api/mo/evolve/runs/${encodeURIComponent(id)}`);
export type AcceptResult = {
  ok: true; applied_to: string; archive_version: number;
  pins: number; forced: boolean; gate_passed: boolean | null;
  /** Not "next session": the skills-index LRU cache key contains no mtime and
   *  nothing clears it at session start, so a written skill is only picked up
   *  by a fresh gateway process. */
  activation: "next_start";
};
export type AcceptRefusal = {
  ok: false; error: "gate_failed" | "stale_baseline" | "no_candidate";
  message: string; verdict?: EvolveGate;
};
/** Accepting is refused (409) when the gate failed or the live skill drifted.
 *  Pass `force` to override — the UI requires a second confirmation for that. */
export const acceptEvolveRun = async (
  port: number, id: string, force = false,
): Promise<AcceptResult | AcceptRefusal> => {
  const res = await moFetchRaw(port, `/api/mo/evolve/runs/${encodeURIComponent(id)}/accept`, {
    method: "POST",
    body: JSON.stringify({ force }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    const d = body?.detail ?? {};
    return { ok: false, error: d.error ?? "gate_failed", message: d.message ?? "未通过采纳门槛", verdict: d.verdict };
  }
  if (!res.ok) throw new Error(`accept failed: ${res.status}`);
  return res.json();
};

export const listEvolvePlans = (port: number, limit = 30) =>
  moFetch<{ data: EvolutionPlan[] }>(port, `/api/mo/evolve/plans?limit=${limit}`);
export const getCalibration = (port: number) =>
  moFetch<Calibration>(port, "/api/mo/evolve/calibration");
/** 「让夜貘现在想一想」 — abstaining is a valid, reported outcome. */
export const reflectNow = (port: number) =>
  moFetch<{ ok: boolean; abstained?: boolean; reason?: string; data?: EvolutionPlan }>(
    port, "/api/mo/evolve/reflect", { method: "POST" });

export const listSkillVersions = (port: number, skill: string) =>
  moFetch<{ data: SkillVersion[]; head: { current_version?: number } }>(
    port, `/api/mo/evolve/skills/${encodeURIComponent(skill)}/versions`);
export const revertSkill = (port: number, skill: string, version?: number) =>
  moFetch<{ ok: boolean; message: string }>(
    port, `/api/mo/evolve/skills/${encodeURIComponent(skill)}/revert`,
    { method: "POST", body: JSON.stringify({ version }) });
export const rejectEvolveRun = (port: number, id: string) =>
  moFetch(port, `/api/mo/evolve/runs/${encodeURIComponent(id)}/reject`, { method: "POST" });
export const getEvolveRunLog = (port: number, id: string, tail = 400) =>
  moFetch<{ data: string; exists: boolean; total_lines?: number; error?: string }>(
    port, `/api/mo/evolve/runs/${encodeURIComponent(id)}/log?tail=${tail}`);
// ---------- mo extension: curation (清点技艺) ----------
// Hermes' curator retires skills on a 90-day timer by moving their directories.
// Mo intercepts that and turns it into a proposal — `guard_installed` reports
// whether the interception is actually in place, because a guard that silently
// failed to install would have the UI claiming protection that isn't there.
export type CuratorStatus = {
  guard_installed: boolean; clamped: boolean;
  enabled: boolean | null; paused: boolean | null;
  stale_after_days: number | null; archive_after_days: number | null;
  interval_hours: number | null; prune_builtins: boolean | null;
  last_run_at: string | null; last_run_summary: string | null;
  run_count: number; last_report_path: string | null;
  counts: { total?: number; active?: number; stale?: number; archived?: number;
            pinned?: number; proposed?: number; retired?: number };
  /** Characters every skill contributes to the always-on system prompt. */
  index_chars: number; proposed_chars: number;
  pending?: PendingChange[];
};
export type UsageRow = {
  name: string; provenance?: string; state?: string; pinned?: boolean;
  use_count?: number; view_count?: number; patch_count?: number;
  activity_count?: number; last_activity_at?: string | null;
  days_idle?: number | null; eligible?: boolean; protected?: boolean;
  skill_md_chars?: number; _persisted?: boolean;
};
export type Retirement = {
  skill: string; proposed_at: number;
  reason: "curator-inactivity" | "agent-delete" | "manual";
  provenance?: string | null; state_at_proposal?: string | null;
  last_activity_at?: string | null; activity_count?: number; use_count?: number;
  days_idle?: number | null; pinned?: boolean;
  skill_md_chars?: number; description?: string; path?: string | null;
  status: "proposed" | "retired" | "kept";
  decided_at?: number | null; archive_path?: string | null;
  /** Whether evolve/archive/<skill>/ holds rewrite history — retiring an
   *  evolved skill leaves two recovery paths, not one. */
  has_version_history?: boolean;
};
export type ArchivedSkill = { name: string; drifted_from_head: boolean };

export const getCuratorStatus = (port: number) =>
  moFetch<CuratorStatus>(port, "/api/mo/curator/status");
export const listCuratorSkills = (port: number) =>
  moFetch<{ data: UsageRow[] }>(port, "/api/mo/curator/skills");
export const listRetirements = (port: number, status?: string) =>
  moFetch<{ data: Retirement[] }>(port, `/api/mo/curator/proposals${status ? `?status=${status}` : ""}`);
export const retireSkill = (port: number, skill: string) =>
  moFetch<{ ok: boolean; message: string; activation: string }>(
    port, `/api/mo/curator/proposals/${encodeURIComponent(skill)}/retire`, { method: "POST" });
export const keepSkill = (port: number, skill: string, pin = false) =>
  moFetch<{ ok: boolean; message: string }>(
    port, `/api/mo/curator/proposals/${encodeURIComponent(skill)}/keep`,
    { method: "POST", body: JSON.stringify({ pin }) });
export const listArchivedSkills = (port: number) =>
  moFetch<{ data: ArchivedSkill[] }>(port, "/api/mo/curator/archived");
export const restoreArchivedSkill = (port: number, skill: string) =>
  moFetch<{ ok: boolean; message: string; drifted_from_head: boolean }>(
    port, `/api/mo/curator/archived/${encodeURIComponent(skill)}/restore`, { method: "POST" });
export const setCuratorPaused = (port: number, paused: boolean) =>
  moFetch<CuratorStatus>(port, "/api/mo/curator/paused",
    { method: "PUT", body: JSON.stringify({ paused }) });
export const runCurator = (port: number, dry_run = false) =>
  moFetch<{ ok: boolean; result?: any; proposed?: number; reason?: string }>(
    port, "/api/mo/curator/run", { method: "POST", body: JSON.stringify({ dry_run }) });
export const setCuratorThresholds = (
  port: number, patch: Partial<{ stale_after_days: number; archive_after_days: number;
                                 interval_hours: number; prune_builtins: boolean }>,
) => moFetch<CuratorStatus>(port, "/api/mo/curator/thresholds",
    { method: "PUT", body: JSON.stringify(patch) });
export const pinSkill = (port: number, skill: string, pinned: boolean) =>
  moFetch<{ ok: boolean }>(port, `/api/mo/curator/skills/${encodeURIComponent(skill)}/pin`,
    { method: "POST", body: JSON.stringify({ pinned }) });

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
export type EvolveSel = {
  endpoint_id: string; optimizer_model: string; eval_model: string;
  /** Reviews the rewrite. Must differ from optimizer_model or the review is a
   *  rubber stamp — the same weights have the same blind spots. */
  critic_model: string;
  /** What 夜貘 reasons with when choosing a target. */
  reflect_model: string;
  endpoints: Endpoint[];
};
export const getEmbeddingConfig = (port: number) => moFetch<EmbeddingSel>(port, "/api/mo/models/embedding");
export const setEmbeddingConfig = (port: number, patch: { endpoint_id: string; model: string; vlm_model?: string; dimension?: number }) =>
  moFetch<EmbeddingSel>(port, "/api/mo/models/embedding", { method: "PUT", body: JSON.stringify(patch) });
export const getEvolveModelConfig = (port: number) => moFetch<EvolveSel>(port, "/api/mo/models/evolve");
export const setEvolveModelConfig = (port: number, patch: Partial<{ endpoint_id: string; optimizer_model: string; eval_model: string; critic_model: string; reflect_model: string }>) =>
  moFetch<EvolveSel>(port, "/api/mo/models/evolve", { method: "PUT", body: JSON.stringify(patch) });

export const getEvolveSchedule = (port: number) => moFetch<EvolveSchedule>(port, "/api/mo/evolve/schedule");
export const setEvolveSchedule = (port: number, s: EvolveSchedule) =>
  moFetch(port, "/api/mo/evolve/schedule", { method: "PUT", body: JSON.stringify(s) });
