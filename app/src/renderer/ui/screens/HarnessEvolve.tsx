import React, { useEffect, useRef, useState, useCallback } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { useAppState } from "../appState";
import { DialogShell, Panel, SectionTabs, StatusBadge } from "../components/EvolveUi";
import { ModelEvolve } from "./ModelEvolve";
import { PendingRestart } from "../components/PendingRestart";
import {
  getEvolveStatus, listEvolveSkills, runEvolve, listEvolveRuns, getEvolveRun,
  acceptEvolveRun, rejectEvolveRun, getEvolveSchedule, setEvolveSchedule, getEvolveRunLog,
  listSkillVersions, revertSkill, getCalibration, reflectNow,
  EvolveStatus, EvolveSkill, EvolveRun, EvolveRunDetail, EvolveSchedule, SkillVersion, EvalSource,
  Calibration,
} from "../../services/mo-api";

function fmt(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const STATUS_LABEL: Record<string, string> = {
  running: "进化中…", done: "待审", failed: "失败", accepted: "已采纳", rejected: "已弃用",
};
const STATUS_COLOR: Record<string, string> = {
  running: "var(--moon)", done: "var(--indigo)", failed: "var(--seal)",
  accepted: "var(--moss)", rejected: "var(--ink-3)",
};

/** How a run's scores were produced. Until the tiered judge landed, every
 *  number here came from a bag-of-words overlap — showing the mode is what
 *  keeps the improvement figure honest. */
const METRIC_LABEL: Record<string, string> = {
  heuristic: "词袋启发式", tiered: "分层评审", judge: "全量 LLM 评审",
};

/** Where the eval set comes from. `synthetic` asks a model to imagine tasks
 *  from the skill's own text — the loop never sees what you actually asked for. */
const SOURCE_LABEL: Record<EvalSource, string> = {
  mixed: "轨迹为主,不足时补合成",
  trajectory: "只用真实轨迹",
  synthetic: "只用合成任务",
};

type EvolutionMode = "gepa" | "model";
type EvolveLoadKey = "status" | "skills" | "runs" | "schedule" | "calibration";

const INITIAL_EVOLVE_LOADING: Record<EvolveLoadKey, boolean> = {
  status: true, skills: true, runs: true, schedule: true, calibration: true,
};
const EMPTY_EVOLVE_ERRORS: Record<EvolveLoadKey, string | null> = {
  status: null, skills: null, runs: null, schedule: null, calibration: null,
};
const INITIAL_EVOLVE_SEQUENCE: Record<EvolveLoadKey, number> = {
  status: 0, skills: 0, runs: 0, schedule: 0, calibration: 0,
};
const CONNECTION_ERROR = "无法连接到本地进化引擎，请确认桌面服务已启动。";

/** Harness 自进化 · 技艺 — drives the GEPA skill-evolution pipeline. */
export function HarnessEvolve({ active = true }: { active?: boolean }) {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const s = useAppState();
  const [status, setStatus] = useState<EvolveStatus | null>(null);
  const [skills, setSkills] = useState<EvolveSkill[]>([]);
  const [runs, setRuns] = useState<EvolveRun[]>([]);
  const [skill, setSkill] = useState("");
  const [iterations, setIterations] = useState(4);
  const [evalSource, setEvalSource] = useState<EvalSource>("mixed");
  const [busy, setBusy] = useState(false);
  const [openRun, setOpenRun] = useState<EvolveRunDetail | null>(null);
  const [sched, setSched] = useState<EvolveSchedule | null>(null);
  const [includeBuiltin, setIncludeBuiltin] = useState(false);
  const [logRun, setLogRun] = useState<EvolveRun | null>(null);
  const [logText, setLogText] = useState("");
  // Set when the backend refuses an accept (409) — turns 采纳 into a two-step
  // force-confirm rather than silently failing.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [cal, setCal] = useState<Calibration | null>(null);
  const [thinking, setThinking] = useState(false);
  // 夜貘's pending pick. Held so the run it justified can carry its prediction —
  // otherwise the prediction is saved, never attached, and never scored.
  const [pendingPlan, setPendingPlan] = useState<{ id: string; skill: string } | null>(null);
  const [evolutionMode, setEvolutionMode] = useState<EvolutionMode>("gepa");
  const [loading, setLoading] = useState<Record<EvolveLoadKey, boolean>>(INITIAL_EVOLVE_LOADING);
  const [errors, setErrors] = useState<Record<EvolveLoadKey, string | null>>(EMPTY_EVOLVE_ERRORS);
  const gepaActive = active && evolutionMode === "gepa";
  const activeRef = useRef(gepaActive);
  const requestSeq = useRef<Record<EvolveLoadKey, number>>({ ...INITIAL_EVOLVE_SEQUENCE });
  const detailSeq = useRef(0);
  const logSeq = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  activeRef.current = gepaActive;

  // Built-in Hermes skills are hidden by default; flip the toggle to evolve them.
  const visibleSkills = includeBuiltin ? skills : skills.filter((s) => !s.builtin);
  const customCount = skills.filter((s) => !s.builtin).length;

  const refresh = useCallback(() => {
    if (!activeRef.current) return;
    if (!moPort) {
      (Object.keys(requestSeq.current) as EvolveLoadKey[]).forEach((key) => {
        requestSeq.current[key] += 1;
      });
      setLoading({ status: false, skills: false, runs: false, schedule: false, calibration: false });
      setErrors({ status: CONNECTION_ERROR, skills: CONNECTION_ERROR, runs: CONNECTION_ERROR, schedule: CONNECTION_ERROR, calibration: CONNECTION_ERROR });
      return;
    }
    const load = <T,>(key: EvolveLoadKey, request: Promise<T>, apply: (value: T) => void) => {
      const seq = ++requestSeq.current[key];
      setLoading((current) => ({ ...current, [key]: true }));
      setErrors((current) => ({ ...current, [key]: null }));
      request.then((value) => {
        if (activeRef.current && seq === requestSeq.current[key]) apply(value);
      }).catch(() => {
        if (!activeRef.current || seq !== requestSeq.current[key]) return;
        setErrors((current) => ({ ...current, [key]: "读取失败，请检查连接后重试。" }));
      }).finally(() => {
        if (!activeRef.current || seq !== requestSeq.current[key]) return;
        setLoading((current) => ({ ...current, [key]: false }));
      });
    };
    load("status", getEvolveStatus(moPort), setStatus);
    load("skills", listEvolveSkills(moPort), (result) => setSkills(result.data));
    load("runs", listEvolveRuns(moPort), (result) => setRuns(result.data));
    load("schedule", getEvolveSchedule(moPort), setSched);
    load("calibration", getCalibration(moPort), setCal);
  }, [moPort]);

  useEffect(() => {
    if (gepaActive) refresh();
  }, [gepaActive, refresh]);

  // A hidden workbench keeps its draft fields, but it must not leave transient
  // review surfaces or polling alive behind another section.
  useEffect(() => {
    if (gepaActive) return;
    (Object.keys(requestSeq.current) as EvolveLoadKey[]).forEach((key) => {
      requestSeq.current[key] += 1;
    });
    detailSeq.current += 1;
    logSeq.current += 1;
    if (refreshTimer.current != null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    setLoading({ status: false, skills: false, runs: false, schedule: false, calibration: false });
    setOpenRun(null);
    setLogRun(null);
    setRefusal(null);
  }, [gepaActive]);

  useEffect(() => () => {
    if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
  }, []);

  // Keep the selected skill valid for the current visible list.
  useEffect(() => {
    if (visibleSkills.length === 0) { setSkill(""); return; }
    if (!visibleSkills.some((s) => s.name === skill)) setSkill(visibleSkills[0].name);
  }, [visibleSkills, skill]);

  // Poll while any run is in flight
  useEffect(() => {
    if (!gepaActive || !moPort) return;
    const anyRunning = runs.some((r) => r.status === "running");
    if (!anyRunning) return;
    const t = setInterval(() => {
      const seq = ++requestSeq.current.runs;
      listEvolveRuns(moPort).then((r) => {
        if (!activeRef.current || seq !== requestSeq.current.runs) return;
        setRuns(r.data);
        setErrors((current) => ({ ...current, runs: null }));
      }).catch(() => {
        if (activeRef.current && seq === requestSeq.current.runs) {
          setErrors((current) => ({ ...current, runs: "自动刷新失败，请重试。" }));
        }
      });
    }, 4000);
    return () => clearInterval(t);
  }, [gepaActive, moPort, runs]);

  const start = () => {
    if (!moPort || !skill || busy) return;
    setBusy(true);
    // Only carry the plan if the user kept 夜貘's pick.
    const planId = pendingPlan?.skill === skill ? pendingPlan.id : undefined;
    runEvolve(moPort, skill, iterations, evalSource, planId).then((r) => {
      if (!r.ok) alert(`进化引擎未就绪：${r.reason ?? "未知原因"}`);
      setPendingPlan(null);
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        if (activeRef.current) refresh();
      }, 500);
    }).catch(() => {}).finally(() => setBusy(false));
  };

  const open = (id: string) => {
    if (!moPort) return;
    const seq = ++detailSeq.current;
    setRefusal(null);   // a fresh look starts from the un-forced state
    getEvolveRun(moPort, id).then((result) => {
      if (activeRef.current && seq === detailSeq.current) setOpenRun(result);
    }).catch(() => {});
  };

  const openLog = (run: EvolveRun) => {
    if (!moPort) return;
    detailSeq.current += 1;
    const seq = ++logSeq.current;
    setOpenRun(null);
    setLogRun(run);
    setLogText("加载中…");
    getEvolveRunLog(moPort, run.id).then((r) => {
      if (activeRef.current && seq === logSeq.current) setLogText(r.data || "(日志为空)");
    }).catch(() => {
      if (activeRef.current && seq === logSeq.current) setLogText("(日志读取失败)");
    });
  };

  // Live-tail the log while its run is still in flight.
  useEffect(() => {
    if (!gepaActive || !moPort || !logRun) return;
    const live = (runs.find((r) => r.id === logRun.id)?.status ?? logRun.status) === "running";
    if (!live) return;
    const t = setInterval(() => {
      const seq = ++logSeq.current;
      getEvolveRunLog(moPort, logRun.id).then((r) => {
        if (activeRef.current && seq === logSeq.current) setLogText(r.data || "(日志为空)");
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [gepaActive, moPort, logRun, runs]);

  // Accepting is refused when the gate failed or the skill drifted. The refusal
  // is not an error to swallow — it becomes a second, explicit confirmation, so
  // a regression can still be deployed but never by a single stray click.
  const accept = (id: string, force = false) => {
    if (!moPort) return;
    acceptEvolveRun(moPort, id, force).then((r) => {
      if (r.ok) {
        setRefusal(null);
        setOpenRun(null);
        refresh();
        setNotice(`已写回 · 存为 v${String(r.archive_version).padStart(4, "0")} · 下次启动生效`);
      } else {
        setRefusal(r.message);
      }
    }).catch(() => {});
  };
  const reject = (id: string) => {
    if (!moPort) return;
    rejectEvolveRun(moPort, id).then(() => { setOpenRun(null); refresh(); }).catch(() => {});
  };

  const loadVersions = useCallback((name: string) => {
    if (!moPort || !name) { setVersions([]); return; }
    listSkillVersions(moPort, name)
      .then((r) => setVersions(r.data))
      .catch(() => setVersions([]));
  }, [moPort]);

  useEffect(() => { loadVersions(skill); }, [skill, loadVersions]);

  const doRevert = (version: number) => {
    if (!moPort || !skill) return;
    if (!confirm(`把「${skill}」回退到 v${String(version).padStart(4, "0")}？当前内容会先存档。`)) return;
    revertSkill(moPort, skill, version).then((r) => {
      setNotice(r.message + " · 下次启动生效");
      loadVersions(skill);
    }).catch(() => setNotice("回退失败"));
  };

  // 「让夜貘现在想一想」 — reflection on demand. Abstaining is reported, not
  // hidden: "no evidence to act on" is a legitimate answer and the alternative
  // is inventing a target.
  const think = () => {
    if (!moPort || thinking) return;
    setThinking(true);
    reflectNow(moPort).then((r) => {
      if (!r.ok) { setNotice(`夜貘没能想下去：${r.reason ?? "未知原因"}`); return; }
      if (r.abstained) { setNotice(r.reason ?? "夜貘这次弃权了。"); return; }
      const p = r.data!;
      setSkill(p.skill);
      setPendingPlan({ id: p.id, skill: p.skill });
      setNotice(`夜貘选了「${p.skill}」：${p.why}`);
    }).catch(() => setNotice("反思失败")).finally(() => setThinking(false));
  };

  const saveSched = (patch: Partial<EvolveSchedule>) => {
    if (!moPort || !sched) return;
    const next = { ...sched, ...patch };
    setSched(next);
    setEvolveSchedule(moPort, next).catch(() => {});
  };

  const RequestNotice = ({ loading: waiting, error, label }: { loading: boolean; error: string | null; label: string }) => {
    if (!waiting && !error) return null;
    return (
      <div role={error ? "alert" : "status"} className={`evolve-request-notice${error ? " is-error" : ""}`}>
        {error ?? `正在读取${label}…`}
        {error && <button type="button" onClick={refresh}>重试</button>}
      </div>
    );
  };

  return (
    <div className="evolve-workbench">
      <div className="evolve-workbench-meta">
        <span className="evolve-eyebrow">HARNESS · 技艺进化</span>
        {evolutionMode === "gepa" && status && (
          <StatusBadge tone={status.ready ? "success" : "warning"}>
            {status.ready ? "引擎就绪 · GEPA" : `未就绪 · ${status.reason}`}
          </StatusBadge>
        )}
        {evolutionMode === "gepa" && <RequestNotice loading={loading.status} error={errors.status} label="引擎状态" />}
      </div>
      <h2 className="evolve-workbench-title">让技艺与模型，各自练得更趁手。</h2>
      <PendingRestart port={moPort} pending={status?.pending} />
      <p className="evolve-workbench-description">
        技艺 GEPA 会生成待审候选，模型微调会改写本地模型权重；两条路径分别记录、分别确认。
      </p>

      <div className="evolve-mode-tabs">
        <SectionTabs
          tabs={[
            { id: "gepa", label: "技艺 GEPA" },
            { id: "model", label: "模型微调" },
          ]}
          active={evolutionMode}
          onChange={(mode) => setEvolutionMode(mode as EvolutionMode)}
          ariaLabel="技艺进化方式"
        />
      </div>

      <section
        id="evolve-panel-gepa"
        role="tabpanel"
        aria-labelledby="evolve-tab-gepa"
        hidden={evolutionMode !== "gepa"}
      >
      <div className="evolve-panel-grid">
        {/* Run + schedule controls */}
        <Panel title="立即进化一次">
          <div className="evolve-form-stack">
            <RequestNotice loading={loading.skills} error={errors.skills} label="可进化技艺" />
            <label className="evolve-field">选一项技艺
              {visibleSkills.length > 0 ? (
                <select value={skill} onChange={(e) => setSkill(e.target.value)} className="evolve-select">
                  {visibleSkills.map((sk) => (
                    <option key={sk.name} value={sk.name}>{sk.name}{sk.builtin ? " · 内置" : ""} · {Math.round(sk.size / 100) / 10}k</option>
                  ))}
                </select>
              ) : (
                <div className="evolve-select evolve-select--placeholder">
                  {loading.skills ? "正在读取…" : errors.skills ? "暂时无法读取技艺" : "暂无自定义技艺"}
                </div>
              )}
            </label>
            <label className="evolve-check">
              <input type="checkbox" checked={includeBuiltin} onChange={(e) => setIncludeBuiltin(e.target.checked)} />
              包含内置技艺{!includeBuiltin && customCount === 0 ? "（勾选后可进化内置技艺）" : ""}
            </label>
            <label className="evolve-field">评测数据来源
              <select value={evalSource} onChange={(e) => setEvalSource(e.target.value as EvalSource)} className="evolve-select">
                {(Object.keys(SOURCE_LABEL) as EvalSource[]).map((k) => (
                  <option key={k} value={k}>{SOURCE_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label className="evolve-field">迭代次数 · {iterations}
              <input type="range" min={1} max={12} value={iterations} onChange={(e) => setIterations(Number(e.target.value))} className="evolve-range" />
            </label>
            <button onClick={start} disabled={busy || !skill || !(status?.ready)} className="evolve-primary-button evolve-button--full">
              {busy ? "启动中…" : "立即进化一次 →"}
            </button>
            <button onClick={think} disabled={thinking || !(status?.ready)} className="evolve-secondary-button evolve-button--full">
              {thinking ? "夜貘在想…" : "让夜貘自己挑一条"}
            </button>
            <div className="evolve-form-hint">
              评测走 {status?.eval_model ?? "qwen"};迭代越多越慢越准。一次约数分钟。
            </div>
          </div>

          <div className="evolve-subsection">
            <RequestNotice loading={loading.schedule} error={errors.schedule} label="自动进化设置" />
            <div className="evolve-subsection-header">
              <span className="evolve-subsection-title">夜间自动进化</span>
              <button
                type="button"
                aria-label="夜间自动进化"
                aria-pressed={!!sched?.enabled}
                disabled={!sched}
                onClick={() => saveSched({ enabled: !sched?.enabled })}
                className={`evolve-switch${sched?.enabled ? " is-on" : ""}`}
              >
                <span />
              </button>
            </div>
            {sched?.enabled && (
              <div className="evolve-schedule-time">
                每天
                <input aria-label="小时" type="number" min={0} max={23} value={sched.hour} onChange={(e) => saveSched({ hour: Number(e.target.value) })} className="evolve-number-input" />:
                <input aria-label="分钟" type="number" min={0} max={59} value={sched.minute} onChange={(e) => saveSched({ minute: Number(e.target.value) })} className="evolve-number-input" />
                · 自动挑一项技艺打磨
              </div>
            )}
            {sched?.enabled && (
              <div className="evolve-schedule-options">
                <select
                  aria-label="夜间评测数据来源"
                  value={sched.eval_source ?? "mixed"}
                  onChange={(e) => saveSched({ eval_source: e.target.value as EvalSource })}
                  className="evolve-select evolve-select--compact"
                >
                  {(Object.keys(SOURCE_LABEL) as EvalSource[]).map((k) => (
                    <option key={k} value={k}>{SOURCE_LABEL[k]}</option>
                  ))}
                </select>
                <label className="evolve-check">
                  <input type="checkbox" checked={sched.reflect ?? true}
                         onChange={(e) => saveSched({ reflect: e.target.checked })} />
                  让夜貘自己挑目标（关掉则按字母轮转）
                </label>
                <div className="evolve-form-hint">
                  夜里正是真实轨迹最派得上用场的时候——白天攒下的差评,晚上拿来打磨。
                </div>
              </div>
            )}
          </div>
        </Panel>

        {/* Runs list */}
        <Panel title="技艺进化记录 · 待审与历史">
          <RequestNotice loading={loading.runs} error={errors.runs} label="进化记录" />
          {!loading.runs && !errors.runs && runs.length === 0 && <div className="evolve-empty-copy">还没有进化记录。选一项技艺,试一次。</div>}
          <div className="evolve-record-list">
            {runs.map((r) => (
              <div key={r.id} className="evolve-record-row" style={{ "--status-color": STATUS_COLOR[r.status] } as React.CSSProperties}>
                <span className={`evolve-record-dot${r.status === "running" ? " is-running" : ""}`} />
                <button
                  type="button"
                  className="evolve-record-main"
                  disabled={r.status === "running"}
                  onClick={() => open(r.id)}
                >
                  <span className="evolve-record-name">{r.skill}</span>
                  {/* Why this skill, in 夜貘's own words. A run that can say why
                      it happened is a different object than one that can't. */}
                  {r.why && (
                    <span className="evolve-record-description">{r.why}</span>
                  )}
                </button>
                <span className="evolve-record-status">{STATUS_LABEL[r.status]}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); openLog(r); }}
                  className="evolve-mini-button"
                >日志</button>
                <span className="evolve-record-time">{fmt(r.created_at)}</span>
              </div>
            ))}
          </div>

          {/* 夜貘's track record. The point of showing this is that it can go
              DOWN — a hit rate near chance means the "reasoning" is decoration,
              and that is exactly what you'd want to know. */}
          <RequestNotice loading={loading.calibration} error={errors.calibration} label="判断校准记录" />
          {cal && (cal.total > 0 || (cal.unverifiable ?? 0) > 0) && (
            <div className="evolve-subsection">
              <div className="evolve-subsection-title">夜貘的判断</div>
              {cal.total > 0 ? (
                <div className="evolve-body-copy">
                  它事先说会怎么变,事后按 holdout 上的分数核对：
                  <span className={`evolve-score${(cal.accuracy ?? 0) >= 0.6 ? " is-good" : " is-warning"}`}>
                    {cal.verified}/{cal.total}
                    {cal.accuracy != null && ` · ${Math.round(cal.accuracy * 100)}%`}
                  </span>
                </div>
              ) : (
                <div className="evolve-empty-copy">还没有可核验的预测。</div>
              )}
              {!!cal.unverifiable && (
                <div className="evolve-form-hint">
                  另有 {cal.unverifiable} 次无法核验（没给出可检验的指标,或那次运行没产出分数）——
                  不计入正确率,但说不清预期本身也是一种信息。
                </div>
              )}
            </div>
          )}

          {/* Versions & revert. Accepting used to be a one-way door: a bare
              write_text with no backup. Every accept now snapshots first, so
              any rewrite can be undone byte-for-byte. */}
          <div className="evolve-subsection">
            <div className="evolve-subsection-title">
              版本与回退 · {skill || "（未选技艺）"}
            </div>
            {versions.length === 0 ? (
              <div className="evolve-empty-copy">这条技艺还没有被改写过。</div>
            ) : (
              <div className="evolve-version-list">
                {versions.map((v) => (
                  <div key={v.version} className="evolve-version-row">
                    <span>v{String(v.version).padStart(4, "0")}</span>
                    <span className="evolve-version-meta">
                      {fmt(v.at)}{v.forced ? " · 强制" : ""}{v.kind === "pre-revert" ? " · 回退前" : ""}
                    </span>
                    <button onClick={() => doRevert(v.version)} className="evolve-mini-button">回退到此</button>
                  </div>
                ))}
              </div>
            )}
            {notice && <div className="evolve-success-note">{notice}</div>}
          </div>
        </Panel>
      </div>

      {/* Diff modal */}
      {openRun && (
        <DialogShell
          title={(
            <span className="evolve-dialog-title-group">
              <span className="evolve-dialog-model-name">{openRun.skill}</span>
              <span
                className="evolve-dialog-run-state"
                style={{ "--status-color": STATUS_COLOR[openRun.status] } as React.CSSProperties}
              >
                {STATUS_LABEL[openRun.status]}
              </span>
              {openRun.metrics?.improvement != null && (
                <span className={`evolve-dialog-score${openRun.metrics.improvement > 0 ? " is-good" : " is-bad"}`}>
                  {openRun.metrics.baseline_score?.toFixed(3)} → {openRun.metrics.evolved_score?.toFixed(3)} ({openRun.metrics.improvement > 0 ? "+" : ""}{openRun.metrics.improvement.toFixed(3)})
                </span>
              )}
            </span>
          )}
          onClose={() => setOpenRun(null)}
          className="evolve-dialog--review"
          footer={(
            <div className="evolve-dialog-toolbar">
              <button type="button" onClick={() => openLog(openRun)} className="evolve-secondary-button">查看日志</button>
              {refusal && <span role="alert" className="evolve-dialog-refusal">{refusal}</span>}
              {openRun.status === "done" && (
                <div className="evolve-dialog-action-group">
                  <button type="button" onClick={() => reject(openRun.id)} className="evolve-secondary-button">弃用</button>
                  {/* The gate says "the numbers don't support this". The critic
                      says "the numbers might, and it's still a bad idea". Both
                      cost the same extra click. */}
                  {(refusal || openRun.critic?.downgrades) ? (
                    // Second step. `force` only when the backend actually
                    // refused — a critic objection must not skip the gate,
                    // so a critic-flagged run still gets checked, and if the
                    // gate also fails the user confirms once more.
                    <button type="button" onClick={() => accept(openRun.id, !!refusal)} className="evolve-danger-button">
                      {refusal ? "确认强制采纳" : "仍要采纳"}
                    </button>
                  ) : (
                    <button type="button" onClick={() => accept(openRun.id)} className="evolve-primary-button">采纳 · 写回技艺</button>
                  )}
                </div>
              )}
            </div>
          )}
        >
              {openRun.error && <div role="alert" className="evolve-dialog-error">错误：{openRun.error}</div>}

              {/* Gate banner — the paired-bootstrap verdict on the holdout.
                  Before this existed, "improvement > 0" was printed to a log
                  and enforced nowhere, so a regression was one click from
                  deployment. */}
              {openRun.gate && (
                <div className={`evolve-review-card${openRun.gate.passed ? " is-success" : " is-warning"}`}>
                  <div className="evolve-review-title">
                    {openRun.gate.passed ? "✓ 通过采纳门槛" : "⚠ 未通过采纳门槛"}
                  </div>
                  {/* gate.reason already carries the specific degraded cause —
                      a fallback and a high failure rate need different wording. */}
                  <div className={`evolve-review-copy${openRun.gate.degraded ? " is-danger" : ""}`}>
                    {openRun.gate.reason}
                  </div>
                  {!!openRun.gate.pin_regressions?.length && (
                    <div className="evolve-review-copy is-danger">
                      在 {openRun.gate.pin_regressions.length} 条历史钉集样本上回归。
                    </div>
                  )}
                </div>
              )}

              {/* 夜貘's stated reasoning, and whether it held up. The
                  prediction was committed to before the run, and checked
                  against numbers the run didn't choose. */}
              {openRun.plan && (
                <div className="evolve-review-card">
                  <div className="evolve-review-title">夜貘为什么挑了它</div>
                  <div className="evolve-review-copy">{openRun.plan.why}</div>
                  {openRun.plan.hypothesis && (
                    <div className="evolve-review-caption">
                      猜测：{openRun.plan.hypothesis}
                    </div>
                  )}
                  {openRun.plan.prediction?.statement && (
                    <div className={`evolve-review-prediction${
                      openRun.plan.prediction.verified === true ? " is-success"
                        : openRun.plan.prediction.verified === false ? " is-danger"
                        : ""
                    }`}>
                      预言：{openRun.plan.prediction.statement}
                      {" · "}
                      {openRun.plan.prediction.verified === true ? "应验了"
                        : openRun.plan.prediction.verified === false ? "没应验"
                        : "无法核验"}
                    </div>
                  )}
                </div>
              )}

              {/* A second opinion from a model that is not the author. */}
              {openRun.critic && !openRun.critic.skipped && (
                <div className={`evolve-review-card${openRun.critic.downgrades ? " is-danger" : ""}`}>
                  <div className="evolve-review-title">
                    另一个模型的审查 · {openRun.critic.verdict === "reject" ? "不建议采纳"
                      : openRun.critic.verdict === "revise" ? "建议再改" : "认可"}
                  </div>
                  {openRun.critic.rationale && (
                    <div className="evolve-review-copy">{openRun.critic.rationale}</div>
                  )}
                  {openRun.critic.risks?.map((r, i) => (
                    <div key={i} className="evolve-review-caption">· {r}</div>
                  ))}
                </div>
              )}
              {openRun.critic?.collusion && (
                <div className="evolve-review-note is-warning">
                  ⚠ 审查模型与优化模型相同,这次没有做交叉审查——同一个模型有同样的盲点,
                  它审自己的改写只会盖章。在「设置 · 模型配置」里换一个审查模型。
                </div>
              )}

              {/* Evidence. Without this a run is a progress bar and a number;
                  with it you can see 夜貘 read six exchanges you marked bad and
                  what they had in common. */}
              {openRun.metrics?.dataset?.counts && (
                <div className="evolve-review-card">
                  <div className="evolve-review-title">依据</div>
                  <div className="evolve-review-copy">
                    {(() => {
                      const c = openRun.metrics!.dataset!.counts!;
                      const parts: string[] = [];
                      if (c.trajectory_neg) parts.push(`${c.trajectory_neg} 条差评轨迹`);
                      if (c.trajectory_pos) parts.push(`${c.trajectory_pos} 条好评轨迹`);
                      if (c.trajectory_unlabelled) parts.push(`${c.trajectory_unlabelled} 条未标注轨迹`);
                      if (c.synthetic) parts.push(`${c.synthetic} 条合成任务`);
                      return parts.length
                        ? `读了 ${parts.join("、")}。`
                        : "没有可用的真实轨迹,本次全部使用合成任务。";
                    })()}
                  </div>
                  {!!openRun.metrics.dataset.failure_modes &&
                    Object.keys(openRun.metrics.dataset.failure_modes).length > 0 && (
                    <div className="evolve-review-copy">
                      主要问题：{Object.entries(openRun.metrics.dataset.failure_modes)
                        .sort((a, b) => b[1] - a[1]).slice(0, 4)
                        .map(([mode, n]) => `${mode} ×${n}`).join("、")}
                    </div>
                  )}
                  {/* Keyed off the counts, not `source`: a `mixed` run that
                      mined nothing is 100% synthetic but still reports its
                      source as "mixed", and that is exactly the case where the
                      caveat matters most. */}
                  {(() => {
                    const c = openRun.metrics!.dataset!.counts!;
                    const fromTrajectories = (c.trajectory_neg ?? 0) + (c.trajectory_pos ?? 0)
                      + (c.trajectory_unlabelled ?? 0);
                    return fromTrajectories === 0 ? (
                      <div className="evolve-review-caption">
                        全部来自合成任务。合成评测集是从技艺自己的文本生成的,是个自指的
                        闭环——它衡量技艺是否贴合自己的描述,而不是是否帮到了你。
                        多聊几轮、给回答打上好评/差评,下次就有真实依据了。
                      </div>
                    ) : null;
                  })()}
                </div>
              )}

              {/* Rejected by a hard constraint. The candidate below is
                  evolved_FAILED.md — shown deliberately, because a rewrite
                  rejected *for* an injection finding is the one most worth
                  reading. It is not deployable and has no accept button. */}
              {!!openRun.constraints?.length && (
                <div className="evolve-review-card is-danger">
                  <div className="evolve-review-title">候选未通过硬约束 · 未写回</div>
                  {openRun.constraints.filter((c) => !c.passed).map((c, i) => (
                    <div key={i} className="evolve-review-copy">
                      <span className="evolve-review-code">[{c.name}]</span>{" "}{c.message}
                    </div>
                  ))}
                </div>
              )}

              {/* Safety findings. Evolved text is written by a model into a
                  file the agent loads, so anything the rewrite *introduced*
                  gets surfaced before you approve it. */}
              {!!openRun.safety?.findings?.length && (
                <div className="evolve-review-card is-warning">
                  <div className="evolve-review-title">新增内容里有 {openRun.safety.findings.length} 处需要过目</div>
                  {openRun.safety.findings.slice(0, 6).map((f, i) => (
                    <div key={i} className={`evolve-safety-finding${f.severity === "high" ? " is-danger" : ""}`}>
                      <span className="evolve-review-code">
                        [{f.severity === "high" ? "高危" : "留意"} · {f.pattern}]
                      </span>{" "}{f.why}
                      <div className="evolve-safety-line">{f.line}</div>
                    </div>
                  ))}
                  {openRun.safety.findings.length > 6 && (
                    <div className="evolve-review-caption">…还有 {openRun.safety.findings.length - 6} 处</div>
                  )}
                </div>
              )}

              {openRun.stale_baseline && (
                <div className="evolve-review-card is-danger">
                  这条技艺在本次进化开始后被改动过 —— 采纳会覆盖那些改动（旧内容仍会存档，可回退）。
                </div>
              )}

              {/* How the numbers were made. A "+0.083" from a bag-of-words
                  overlap and one from an LLM judge are not the same claim. */}
              {openRun.metrics?.fitness && (
                <div className="evolve-metric-note">
                  评分方式：{METRIC_LABEL[openRun.metrics.fitness.metric_mode ?? "heuristic"]}
                  {openRun.metrics.fitness.metric_mode !== "heuristic" && (
                    <> · 评审 {openRun.metrics.fitness.judge_calls ?? 0} 次
                      （缓存命中 {openRun.metrics.fitness.cache_hits ?? 0}
                      {(openRun.metrics.fitness.judge_failures ?? 0) > 0 && `，失败 ${openRun.metrics.fitness.judge_failures}`}）
                      {openRun.metrics.fitness.capped && " · 已达评审上限"}
                    </>
                  )}
                  {openRun.metrics.fitness.collusion_risk && (
                    <div className="is-warning">
                      ⚠ 评审模型与优化模型相同 —— 同一个模型有同样的盲点，评分可能偏松。
                    </div>
                  )}
                </div>
              )}

              {openRun.diff ? (
                <pre className="evolve-diff">
                  {openRun.diff.split("\n").map((ln, i) => (
                    <span
                      key={i}
                      className={`evolve-diff-line${
                        ln.startsWith("+") && !ln.startsWith("+++") ? " is-add"
                          : ln.startsWith("-") && !ln.startsWith("---") ? " is-remove"
                          : ln.startsWith("@@") ? " is-hunk"
                          : ""
                      }`}
                    >
                      {ln || " "}
                    </span>
                  ))}
                </pre>
              ) : (
                <div className="evolve-empty-copy">
                  {openRun.status === "failed" && !openRun.constraints
                    ? "这次运行没有产出候选,详情见日志。"
                    : "没有可显示的差异（可能进化未改动正文）。"}
                </div>
              )}
        </DialogShell>
      )}

      {/* Log modal */}
      {logRun && (
        <DialogShell
          title={(
            <span className="evolve-dialog-title-group">
              <span>进化日志 · </span>
              <span className="evolve-dialog-model-name">{logRun.skill}</span>
            </span>
          )}
          onClose={() => setLogRun(null)}
          className="evolve-dialog--log"
          footer={(
            <>
              {(runs.find((r) => r.id === logRun.id)?.status ?? logRun.status) === "running" && (
                <span role="status" className="evolve-live-status">● 实时刷新中</span>
              )}
              <button type="button" onClick={() => openLog(logRun)} className="evolve-secondary-button">刷新</button>
            </>
          )}
        >
            <div ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }} className="evolve-log-scroll">
              <pre className="evolve-log-output">{logText}</pre>
            </div>
        </DialogShell>
      )}
      </section>

      {/* Keep the fine-tune form mounted when switching modes so its draft is
          preserved; ModelEvolve itself pauses all fetching while inactive. */}
      <section
        id="evolve-panel-model"
        role="tabpanel"
        aria-labelledby="evolve-tab-model"
        hidden={evolutionMode !== "model"}
      >
        <ModelEvolve active={active && evolutionMode === "model"} onGoSettings={() => s.go("settings")} />
      </section>
    </div>
  );
}
