import React, { useEffect, useState, useCallback } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { useAppState } from "../appState";
import { TapeCard } from "../components/TapeCard";
import { ModelEvolve } from "./ModelEvolve";
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

/** Harness 自进化 · 技艺 — drives the GEPA skill-evolution pipeline. */
export function HarnessEvolve() {
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

  // Built-in Hermes skills are hidden by default; flip the toggle to evolve them.
  const visibleSkills = includeBuiltin ? skills : skills.filter((s) => !s.builtin);
  const customCount = skills.filter((s) => !s.builtin).length;

  const refresh = useCallback(() => {
    if (!moPort) return;
    getEvolveStatus(moPort).then(setStatus).catch(() => {});
    listEvolveSkills(moPort).then((r) => setSkills(r.data)).catch(() => {});
    listEvolveRuns(moPort).then((r) => setRuns(r.data)).catch(() => {});
    getEvolveSchedule(moPort).then(setSched).catch(() => {});
    getCalibration(moPort).then(setCal).catch(() => {});
  }, [moPort]);

  useEffect(() => { refresh(); }, [refresh]);

  // Keep the selected skill valid for the current visible list.
  useEffect(() => {
    if (visibleSkills.length === 0) { setSkill(""); return; }
    if (!visibleSkills.some((s) => s.name === skill)) setSkill(visibleSkills[0].name);
  }, [visibleSkills, skill]);

  // Poll while any run is in flight
  useEffect(() => {
    if (!moPort) return;
    const anyRunning = runs.some((r) => r.status === "running");
    if (!anyRunning) return;
    const t = setInterval(() => {
      listEvolveRuns(moPort).then((r) => setRuns(r.data)).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [moPort, runs]);

  const start = () => {
    if (!moPort || !skill || busy) return;
    setBusy(true);
    // Only carry the plan if the user kept 夜貘's pick.
    const planId = pendingPlan?.skill === skill ? pendingPlan.id : undefined;
    runEvolve(moPort, skill, iterations, evalSource, planId).then((r) => {
      if (!r.ok) alert(`进化引擎未就绪：${r.reason ?? "未知原因"}`);
      setPendingPlan(null);
      setTimeout(refresh, 500);
    }).catch(() => {}).finally(() => setBusy(false));
  };

  const open = (id: string) => {
    if (!moPort) return;
    setRefusal(null);   // a fresh look starts from the un-forced state
    getEvolveRun(moPort, id).then(setOpenRun).catch(() => {});
  };

  const openLog = (run: EvolveRun) => {
    if (!moPort) return;
    setLogRun(run);
    setLogText("加载中…");
    getEvolveRunLog(moPort, run.id).then((r) => setLogText(r.data || "(日志为空)")).catch(() => setLogText("(日志读取失败)"));
  };

  // Live-tail the log while its run is still in flight.
  useEffect(() => {
    if (!moPort || !logRun) return;
    const live = runs.find((r) => r.id === logRun.id)?.status === "running" || logRun.status === "running";
    if (!live) return;
    const t = setInterval(() => {
      getEvolveRunLog(moPort, logRun.id).then((r) => setLogText(r.data || "(日志为空)")).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [moPort, logRun, runs]);

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
        setNotice(`已写回 · 存为 v${String(r.archive_version).padStart(4, "0")} · 下次新会话生效`);
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
      setNotice(r.message + " · 下次新会话生效");
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

  return (
    <div style={{ marginTop: 48 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 11, letterSpacing: "0.2em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>HARNESS · 技艺自进化</span>
        {status && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace", color: status.ready ? "var(--moss)" : "var(--moon)", border: `1px solid ${status.ready ? "var(--moss)" : "var(--moon)"}`, borderRadius: 99, padding: "2px 9px" }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, background: "currentColor" }} />
            {status.ready ? "引擎就绪 · GEPA" : `未就绪 · ${status.reason}`}
          </span>
        )}
      </div>
      <h2 style={{ margin: "8px 0 6px", fontFamily: "'Noto Serif SC', serif", fontSize: 21, fontWeight: 650 }}>夜貘会把自己的技艺,练得更趁手。</h2>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: "var(--ink-2)", maxWidth: 640 }}>
        交给「分身·夜貘（进化）」:它用 GEPA 优化器反复打磨某个技能的 SKILL.md,生成候选先进暂存区。你看过 diff、点「采纳」,才会真正写回。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26, marginTop: 26, alignItems: "start" }}>
        {/* Run + schedule controls */}
        <TapeCard tapeLeft={true} tapeRotate="2deg" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650, marginBottom: 14 }}>立即进化一次</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={lbl}>选一项技艺
              {visibleSkills.length > 0 ? (
                <select value={skill} onChange={(e) => setSkill(e.target.value)} style={sel}>
                  {visibleSkills.map((sk) => (
                    <option key={sk.name} value={sk.name}>{sk.name}{sk.builtin ? " · 内置" : ""} · {Math.round(sk.size / 100) / 10}k</option>
                  ))}
                </select>
              ) : (
                <div style={{ ...sel, display: "flex", alignItems: "center", color: "var(--ink-3)" }}>暂无自定义技艺</div>
              )}
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-2)", cursor: "pointer" }}>
              <input type="checkbox" checked={includeBuiltin} onChange={(e) => setIncludeBuiltin(e.target.checked)} />
              包含内置技艺{!includeBuiltin && customCount === 0 ? "（勾选后可进化内置技艺）" : ""}
            </label>
            <label style={lbl}>评测数据来源
              <select value={evalSource} onChange={(e) => setEvalSource(e.target.value as EvalSource)} style={sel}>
                {(Object.keys(SOURCE_LABEL) as EvalSource[]).map((k) => (
                  <option key={k} value={k}>{SOURCE_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label style={lbl}>迭代次数 · {iterations}
              <input type="range" min={1} max={12} value={iterations} onChange={(e) => setIterations(Number(e.target.value))} style={{ width: "100%" }} />
            </label>
            <button onClick={start} disabled={busy || !skill || !(status?.ready)} style={{
              height: 40, borderRadius: 9, border: "none",
              background: (busy || !status?.ready) ? "var(--line)" : "var(--seal)",
              color: "oklch(98% 0.01 85)", fontSize: 14, fontWeight: 600,
              cursor: (busy || !status?.ready) ? "default" : "pointer", fontFamily: "'Noto Serif SC', serif",
            }}>{busy ? "启动中…" : "立即进化一次 →"}</button>
            <button onClick={think} disabled={thinking || !(status?.ready)} style={{
              height: 34, borderRadius: 9, border: "1px solid var(--line-2)",
              background: "transparent", color: "var(--ink-2)", fontSize: 12.5,
              cursor: (thinking || !status?.ready) ? "default" : "pointer",
            }}>{thinking ? "夜貘在想…" : "让夜貘自己挑一条"}</button>
            <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.6 }}>
              评测走 {status?.eval_model ?? "qwen"};迭代越多越慢越准。一次约数分钟。
            </div>
          </div>

          <div style={{ borderTop: "1px dashed var(--line)", marginTop: 18, paddingTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>夜间自动进化</span>
              <button onClick={() => saveSched({ enabled: !sched?.enabled })} style={{
                width: 44, height: 24, borderRadius: 99, border: "none", cursor: "pointer", position: "relative",
                background: sched?.enabled ? "var(--moss)" : "var(--line-2)", transition: "background .2s",
              }}>
                <span style={{ position: "absolute", top: 3, left: sched?.enabled ? 23 : 3, width: 18, height: 18, borderRadius: 99, background: "#fff", transition: "left .2s" }} />
              </button>
            </div>
            {sched?.enabled && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 12.5, color: "var(--ink-2)" }}>
                每天
                <input type="number" min={0} max={23} value={sched.hour} onChange={(e) => saveSched({ hour: Number(e.target.value) })} style={numIn} />:
                <input type="number" min={0} max={59} value={sched.minute} onChange={(e) => saveSched({ minute: Number(e.target.value) })} style={numIn} />
                · 自动挑一项技艺打磨
              </div>
            )}
            {sched?.enabled && (
              <div style={{ marginTop: 8 }}>
                <select
                  value={sched.eval_source ?? "mixed"}
                  onChange={(e) => saveSched({ eval_source: e.target.value as EvalSource })}
                  style={{ ...sel, height: 30, fontSize: 12 }}
                >
                  {(Object.keys(SOURCE_LABEL) as EvalSource[]).map((k) => (
                    <option key={k} value={k}>{SOURCE_LABEL[k]}</option>
                  ))}
                </select>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12,
                                color: "var(--ink-2)", cursor: "pointer", marginTop: 8 }}>
                  <input type="checkbox" checked={sched.reflect ?? true}
                         onChange={(e) => saveSched({ reflect: e.target.checked })} />
                  让夜貘自己挑目标（关掉则按字母轮转）
                </label>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 5, lineHeight: 1.6 }}>
                  夜里正是真实轨迹最派得上用场的时候——白天攒下的差评,晚上拿来打磨。
                </div>
              </div>
            )}
          </div>
        </TapeCard>

        {/* Runs list */}
        <TapeCard tapeLeft={false} tapeRotate="-2deg" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650, marginBottom: 12 }}>蜕皮记录 · 待审与历史</div>
          {runs.length === 0 && <div style={{ fontSize: 13, color: "var(--ink-3)" }}>还没有进化记录。选一项技艺,试一次。</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 320, overflowY: "auto" }}>
            {runs.map((r) => (
              <div key={r.id} onClick={() => r.status !== "running" && open(r.id)} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                border: "1px solid var(--line)", borderRadius: 8,
                cursor: r.status === "running" ? "default" : "pointer", background: "var(--card)",
              }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_COLOR[r.status], flexShrink: 0, ...(r.status === "running" ? { animation: "breathe 1.4s ease-in-out infinite" } : {}) }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>{r.skill}</span>
                  {/* Why this skill, in 夜貘's own words. A run that can say why
                      it happened is a different object than one that can't. */}
                  {r.why && (
                    <span style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5,
                                   display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                                   overflow: "hidden" }}>{r.why}</span>
                  )}
                </span>
                <span style={{ fontSize: 11, color: STATUS_COLOR[r.status] }}>{STATUS_LABEL[r.status]}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); openLog(r); }}
                  style={{ flexShrink: 0, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", borderRadius: 6, fontSize: 11, padding: "2px 8px", cursor: "pointer" }}
                >日志</button>
                <span style={{ fontSize: 11, color: "var(--ink-3)", flexShrink: 0 }}>{fmt(r.created_at)}</span>
              </div>
            ))}
          </div>

          {/* 夜貘's track record. The point of showing this is that it can go
              DOWN — a hit rate near chance means the "reasoning" is decoration,
              and that is exactly what you'd want to know. */}
          {cal && (cal.total > 0 || (cal.unverifiable ?? 0) > 0) && (
            <div style={{ borderTop: "1px dashed var(--line)", marginTop: 18, paddingTop: 14 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>夜貘的判断</div>
              {cal.total > 0 ? (
                <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.7 }}>
                  它事先说会怎么变,事后按 holdout 上的分数核对：
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", marginLeft: 4,
                                 color: (cal.accuracy ?? 0) >= 0.6 ? "var(--moss)" : "var(--moon)" }}>
                    {cal.verified}/{cal.total}
                    {cal.accuracy != null && ` · ${Math.round(cal.accuracy * 100)}%`}
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>还没有可核验的预测。</div>
              )}
              {!!cal.unverifiable && (
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4, lineHeight: 1.6 }}>
                  另有 {cal.unverifiable} 次无法核验（没给出可检验的指标,或那次运行没产出分数）——
                  不计入正确率,但说不清预期本身也是一种信息。
                </div>
              )}
            </div>
          )}

          {/* Versions & revert. Accepting used to be a one-way door: a bare
              write_text with no backup. Every accept now snapshots first, so
              any rewrite can be undone byte-for-byte. */}
          <div style={{ borderTop: "1px dashed var(--line)", marginTop: 18, paddingTop: 14 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>
              版本与回退 · {skill || "（未选技艺）"}
            </div>
            {versions.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>这条技艺还没有被改写过。</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto" }}>
                {versions.map((v) => (
                  <div key={v.version} style={{
                    display: "flex", alignItems: "center", gap: 10, fontSize: 12,
                    fontFamily: "'JetBrains Mono', monospace", color: "var(--ink-2)",
                  }}>
                    <span style={{ color: "var(--ink-3)" }}>v{String(v.version).padStart(4, "0")}</span>
                    <span style={{ flex: 1, color: "var(--ink-3)" }}>
                      {fmt(v.at)}{v.forced ? " · 强制" : ""}{v.kind === "pre-revert" ? " · 回退前" : ""}
                    </span>
                    <button onClick={() => doRevert(v.version)} style={{
                      border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)",
                      borderRadius: 6, fontSize: 11, padding: "2px 8px", cursor: "pointer",
                    }}>回退到此</button>
                  </div>
                ))}
              </div>
            )}
            {notice && <div style={{ fontSize: 11.5, color: "var(--moss)", marginTop: 8 }}>{notice}</div>}
          </div>
        </TapeCard>
      </div>

      {/* Model self-evolution (part 2): weight fine-tuning */}
      <ModelEvolve onGoSettings={() => s.go("settings")} />

      {/* Diff modal */}
      {openRun && (
        <div onClick={() => setOpenRun(null)} style={{
          position: "fixed", inset: 0, background: "oklch(20% 0.02 60 / 0.45)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 40,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "var(--card)", borderRadius: 12, boxShadow: "var(--shadow)",
            width: "min(860px, 92vw)", maxHeight: "86vh", display: "flex", flexDirection: "column",
            border: "1px solid var(--line)",
          }}>
            <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, fontWeight: 650 }}>{openRun.skill}</span>
              <span style={{ fontSize: 11, color: STATUS_COLOR[openRun.status] }}>{STATUS_LABEL[openRun.status]}</span>
              {openRun.metrics?.improvement != null && (
                <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: openRun.metrics.improvement > 0 ? "var(--moss)" : "var(--seal)" }}>
                  {openRun.metrics.baseline_score?.toFixed(3)} → {openRun.metrics.evolved_score?.toFixed(3)} ({openRun.metrics.improvement > 0 ? "+" : ""}{openRun.metrics.improvement.toFixed(3)})
                </span>
              )}
              <span style={{ marginLeft: "auto", cursor: "pointer", color: "var(--ink-3)", fontSize: 18 }} onClick={() => setOpenRun(null)}>×</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px" }}>
              {openRun.error && <div style={{ color: "var(--seal)", fontSize: 13, marginBottom: 12 }}>错误：{openRun.error}</div>}

              {/* Gate banner — the paired-bootstrap verdict on the holdout.
                  Before this existed, "improvement > 0" was printed to a log
                  and enforced nowhere, so a regression was one click from
                  deployment. */}
              {openRun.gate && (
                <div style={{
                  marginBottom: 14, padding: "10px 14px", borderRadius: 9, fontSize: 12.5, lineHeight: 1.6,
                  border: `1px solid ${openRun.gate.passed ? "var(--moss)" : "var(--moon)"}`,
                  background: openRun.gate.passed ? "var(--moss-soft)" : "transparent",
                  color: openRun.gate.passed ? "var(--moss)" : "var(--moon)",
                }}>
                  <div style={{ fontWeight: 600 }}>
                    {openRun.gate.passed ? "✓ 通过采纳门槛" : "⚠ 未通过采纳门槛"}
                  </div>
                  {/* gate.reason already carries the specific degraded cause —
                      a fallback and a high failure rate need different wording. */}
                  <div style={{ color: openRun.gate.degraded ? "var(--seal)" : "var(--ink-2)", marginTop: 3 }}>
                    {openRun.gate.reason}
                  </div>
                  {!!openRun.gate.pin_regressions?.length && (
                    <div style={{ color: "var(--seal)", marginTop: 3 }}>
                      在 {openRun.gate.pin_regressions.length} 条历史钉集样本上回归。
                    </div>
                  )}
                </div>
              )}

              {/* 夜貘's stated reasoning, and whether it held up. The
                  prediction was committed to before the run, and checked
                  against numbers the run didn't choose. */}
              {openRun.plan && (
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 9, fontSize: 12.5,
                              border: "1px solid var(--line-2)", lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 600 }}>夜貘为什么挑了它</div>
                  <div style={{ color: "var(--ink-2)", marginTop: 3 }}>{openRun.plan.why}</div>
                  {openRun.plan.hypothesis && (
                    <div style={{ color: "var(--ink-3)", marginTop: 3 }}>
                      猜测：{openRun.plan.hypothesis}
                    </div>
                  )}
                  {openRun.plan.prediction?.statement && (
                    <div style={{ marginTop: 5,
                                  color: openRun.plan.prediction.verified === true ? "var(--moss)"
                                       : openRun.plan.prediction.verified === false ? "var(--seal)"
                                       : "var(--ink-3)" }}>
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
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 9, fontSize: 12.5,
                              lineHeight: 1.6,
                              border: `1px solid ${openRun.critic.downgrades ? "var(--seal)" : "var(--line-2)"}` }}>
                  <div style={{ fontWeight: 600,
                                color: openRun.critic.downgrades ? "var(--seal)" : "var(--ink-1)" }}>
                    另一个模型的审查 · {openRun.critic.verdict === "reject" ? "不建议采纳"
                      : openRun.critic.verdict === "revise" ? "建议再改" : "认可"}
                  </div>
                  {openRun.critic.rationale && (
                    <div style={{ color: "var(--ink-2)", marginTop: 3 }}>{openRun.critic.rationale}</div>
                  )}
                  {openRun.critic.risks?.map((r, i) => (
                    <div key={i} style={{ color: "var(--ink-3)", marginTop: 2 }}>· {r}</div>
                  ))}
                </div>
              )}
              {openRun.critic?.collusion && (
                <div style={{ marginBottom: 14, fontSize: 11.5, color: "var(--moon)", lineHeight: 1.6 }}>
                  ⚠ 审查模型与优化模型相同,这次没有做交叉审查——同一个模型有同样的盲点,
                  它审自己的改写只会盖章。在「设置 · 模型配置」里换一个审查模型。
                </div>
              )}

              {/* Evidence. Without this a run is a progress bar and a number;
                  with it you can see 夜貘 read six exchanges you marked bad and
                  what they had in common. */}
              {openRun.metrics?.dataset?.counts && (
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 9, fontSize: 12.5,
                              border: "1px solid var(--line-2)", lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 600 }}>依据</div>
                  <div style={{ color: "var(--ink-2)", marginTop: 3 }}>
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
                    <div style={{ color: "var(--ink-2)", marginTop: 3 }}>
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
                      <div style={{ color: "var(--ink-3)", marginTop: 3, fontSize: 11.5 }}>
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
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 9, fontSize: 12.5,
                              border: "1px solid var(--seal)", lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 600, color: "var(--seal)" }}>候选未通过硬约束 · 未写回</div>
                  {openRun.constraints.filter((c) => !c.passed).map((c, i) => (
                    <div key={i} style={{ marginTop: 3, color: "var(--ink-2)" }}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>[{c.name}]</span>{" "}{c.message}
                    </div>
                  ))}
                </div>
              )}

              {/* Safety findings. Evolved text is written by a model into a
                  file the agent loads, so anything the rewrite *introduced*
                  gets surfaced before you approve it. */}
              {!!openRun.safety?.findings?.length && (
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 9, fontSize: 12.5,
                              border: "1px solid var(--moon)", lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 600, color: "var(--moon)" }}>新增内容里有 {openRun.safety.findings.length} 处需要过目</div>
                  {openRun.safety.findings.slice(0, 6).map((f, i) => (
                    <div key={i} style={{ marginTop: 4, color: f.severity === "high" ? "var(--seal)" : "var(--ink-2)" }}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                        [{f.severity === "high" ? "高危" : "留意"} · {f.pattern}]
                      </span>{" "}{f.why}
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--ink-3)",
                                    whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{f.line}</div>
                    </div>
                  ))}
                  {openRun.safety.findings.length > 6 && (
                    <div style={{ marginTop: 4, color: "var(--ink-3)" }}>…还有 {openRun.safety.findings.length - 6} 处</div>
                  )}
                </div>
              )}

              {openRun.stale_baseline && (
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 9, fontSize: 12.5,
                              border: "1px solid var(--seal)", color: "var(--seal)" }}>
                  这条技艺在本次进化开始后被改动过 —— 采纳会覆盖那些改动（旧内容仍会存档，可回退）。
                </div>
              )}

              {/* How the numbers were made. A "+0.083" from a bag-of-words
                  overlap and one from an LLM judge are not the same claim. */}
              {openRun.metrics?.fitness && (
                <div style={{ marginBottom: 14, fontSize: 11.5, color: "var(--ink-3)",
                              fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.7 }}>
                  评分方式：{METRIC_LABEL[openRun.metrics.fitness.metric_mode ?? "heuristic"]}
                  {openRun.metrics.fitness.metric_mode !== "heuristic" && (
                    <> · 评审 {openRun.metrics.fitness.judge_calls ?? 0} 次
                      （缓存命中 {openRun.metrics.fitness.cache_hits ?? 0}
                      {(openRun.metrics.fitness.judge_failures ?? 0) > 0 && `，失败 ${openRun.metrics.fitness.judge_failures}`}）
                      {openRun.metrics.fitness.capped && " · 已达评审上限"}
                    </>
                  )}
                  {openRun.metrics.fitness.collusion_risk && (
                    <div style={{ color: "var(--moon)" }}>
                      ⚠ 评审模型与优化模型相同 —— 同一个模型有同样的盲点，评分可能偏松。
                    </div>
                  )}
                </div>
              )}

              {openRun.diff ? (
                <pre style={{ margin: 0, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {openRun.diff.split("\n").map((ln, i) => (
                    <div key={i} style={{
                      color: ln.startsWith("+") && !ln.startsWith("+++") ? "var(--moss)"
                        : ln.startsWith("-") && !ln.startsWith("---") ? "var(--seal)"
                        : ln.startsWith("@@") ? "var(--indigo)" : "var(--ink-2)",
                      background: ln.startsWith("+") && !ln.startsWith("+++") ? "var(--moss-soft)"
                        : ln.startsWith("-") && !ln.startsWith("---") ? "var(--seal-soft)" : "transparent",
                    }}>{ln || " "}</div>
                  ))}
                </pre>
              ) : (
                <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
                  {openRun.status === "failed" && !openRun.constraints
                    ? "这次运行没有产出候选,详情见日志。"
                    : "没有可显示的差异（可能进化未改动正文）。"}
                </div>
              )}
            </div>
            <div style={{ padding: "14px 22px", borderTop: "1px solid var(--line)", display: "flex", gap: 12, alignItems: "center" }}>
              <button onClick={() => openLog(openRun)} style={{ height: 38, padding: "0 16px", borderRadius: 9, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", fontSize: 13, cursor: "pointer" }}>查看日志</button>
              {refusal && (
                <span style={{ fontSize: 12, color: "var(--seal)", maxWidth: 380, lineHeight: 1.5 }}>{refusal}</span>
              )}
              {openRun.status === "done" && (
                <div style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
                  <button onClick={() => reject(openRun.id)} style={{ height: 38, padding: "0 18px", borderRadius: 9, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", fontSize: 13, cursor: "pointer" }}>弃用</button>
                  {/* The gate says "the numbers don't support this". The critic
                      says "the numbers might, and it's still a bad idea". Both
                      cost the same extra click. */}
                  {(refusal || openRun.critic?.downgrades) ? (
                    // Second step. `force` only when the backend actually
                    // refused — a critic objection must not skip the gate,
                    // so a critic-flagged run still gets checked, and if the
                    // gate also fails the user confirms once more.
                    <button onClick={() => accept(openRun.id, !!refusal)} style={{ height: 38, padding: "0 20px", borderRadius: 9, border: "1px solid var(--seal)", background: "transparent", color: "var(--seal)", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Serif SC', serif" }}>{refusal ? "确认强制采纳" : "仍要采纳"}</button>
                  ) : (
                    <button onClick={() => accept(openRun.id)} style={{ height: 38, padding: "0 20px", borderRadius: 9, border: "none", background: "var(--seal)", color: "oklch(98% 0.01 85)", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Serif SC', serif" }}>采纳 · 写回技艺</button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Log modal */}
      {logRun && (
        <div onClick={() => setLogRun(null)} style={{
          position: "fixed", inset: 0, background: "oklch(20% 0.02 60 / 0.45)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 51, padding: 40,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "var(--card)", borderRadius: 12, boxShadow: "var(--shadow)",
            width: "min(900px, 94vw)", maxHeight: "86vh", display: "flex", flexDirection: "column",
            border: "1px solid var(--line)",
          }}>
            <div style={{ padding: "16px 22px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650 }}>进化日志 · {logRun.skill}</span>
              {(runs.find((r) => r.id === logRun.id)?.status ?? logRun.status) === "running" && (
                <span style={{ fontSize: 11, color: "var(--moon)" }}>● 实时刷新中</span>
              )}
              <button onClick={() => openLog(logRun)} style={{ marginLeft: "auto", border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", borderRadius: 6, fontSize: 12, padding: "3px 10px", cursor: "pointer" }}>刷新</button>
              <span style={{ cursor: "pointer", color: "var(--ink-3)", fontSize: 18 }} onClick={() => setLogRun(null)}>×</span>
            </div>
            <div ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }} style={{ flex: 1, overflowY: "auto", padding: "14px 20px", background: "var(--bg-2)" }}>
              <pre style={{ margin: 0, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--ink-2)" }}>{logText}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const lbl: React.CSSProperties = { fontSize: 12, color: "var(--ink-3)", display: "flex", flexDirection: "column", gap: 6 };
const sel: React.CSSProperties = { height: 36, borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--bg-2)", color: "var(--ink)", fontSize: 13, padding: "0 10px", fontFamily: "'JetBrains Mono', monospace" };
const numIn: React.CSSProperties = { width: 48, height: 30, borderRadius: 7, border: "1px solid var(--line-2)", background: "var(--bg-2)", color: "var(--ink)", fontSize: 13, textAlign: "center", fontFamily: "'JetBrains Mono', monospace" };
