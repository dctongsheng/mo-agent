import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { Panel } from "../components/EvolveUi";
import {
  getLearningGraph, getUsageAnalytics, getCalibration,
  LearningGraph, UsageAnalytics, Calibration,
} from "../../services/mo-api";

function approxTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/** 学到了什么 / 花了多少 — two read-only views over endpoints Hermes already
 *  ships. Nothing here writes.
 *
 *  Deliberately does NOT wire DELETE /api/learning/node: it archives the skill
 *  AND clears the prompt cache, i.e. it hot-swaps a running session. Retiring
 *  goes through the curator proposal path instead.
 *
 *  Memory node ids are positional (`memory:<source>:<index>`) and go stale
 *  after any memory write, so nothing here holds one across an operation. */
export function HarnessLedger({ active = true }: { active?: boolean } = {}) {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const [graph, setGraph] = useState<LearningGraph | null>(null);
  const [usage, setUsage] = useState<UsageAnalytics | null>(null);
  const [cal, setCal] = useState<Calibration | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const activeRef = useRef(active);
  const refreshSeq = useRef(0);
  activeRef.current = active;

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    if (!activeRef.current) return;
    if (!moPort) {
      setLoading(false);
      setLoadErrors(["graph", "usage", "calibration"]);
      return;
    }
    setLoading(true);
    setLoadErrors([]);
    const [graphResult, usageResult, calibrationResult] = await Promise.allSettled([
      getLearningGraph(moPort),
      getUsageAnalytics(moPort, days),
      getCalibration(moPort),
    ]);
    if (!activeRef.current || seq !== refreshSeq.current) return;
    const errors: string[] = [];
    if (graphResult.status === "fulfilled") setGraph(graphResult.value);
    else errors.push("graph");
    if (usageResult.status === "fulfilled") setUsage(usageResult.value);
    else errors.push("usage");
    if (calibrationResult.status === "fulfilled") setCal(calibrationResult.value);
    else errors.push("calibration");
    setLoadErrors(errors);
    setLoading(false);
  }, [moPort, days]);

  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (active) return;
    refreshSeq.current += 1;
    setLoading(false);
  }, [active]);

  const daily = usage?.daily ?? [];
  const tot = daily.reduce((a, d) => ({
    input: a.input + (d.input_tokens || 0),
    output: a.output + (d.output_tokens || 0),
    cache: a.cache + (d.cache_read_tokens || 0),
    cost: a.cost + (d.actual_cost || d.estimated_cost || 0),
    sessions: a.sessions + (d.sessions || 0),
    calls: a.calls + (d.api_calls || 0),
  }), { input: 0, output: 0, cache: 0, cost: 0, sessions: 0, calls: 0 });

  const top = (graph?.clusters ?? []).slice().sort((a, b) => b.count - a.count).slice(0, 6);
  const learned = graph?.nodes.filter((n) => n.kind === "skill") ?? [];

  return (
    <div className="evolve-workbench">
      <div className="evolve-eyebrow">LEDGER · 学到了什么 · 花了多少</div>
      <h2 className="evolve-workbench-title">
        它到底学到了什么,又值不值。
      </h2>
      <p className="evolve-workbench-description">
        左边是它真正用过或自己写下的东西,右边是这些事花掉的钱。
        「夜貘的判断准确率」答的是准不准,这一页答的是值不值。
      </p>

      {loadErrors.length > 0 && (
        <div className="evolve-load-callout" role="status">
          <span>部分成效台账暂时读不到，已有数据仍可继续查看。</span>
          <button type="button" onClick={refresh}>重试</button>
        </div>
      )}

      <div className="evolve-panel-grid">
        <Panel title="学到了什么">
          {loading && !graph ? (
            <div className="evolve-state-text">正在读取学习图谱…</div>
          ) : loadErrors.includes("graph") && !graph ? (
            <div className="evolve-state-text is-error">学习图谱读取失败，不能判断当前是否为空。</div>
          ) : !graph ? (
            <div className="evolve-state-text">学习图谱尚未生成。</div>
          ) : learned.length === 0 ? (
            <div className="evolve-state-text">
              还没有它用过或自己写下的技艺 —— 图谱只收这两类,内置但没碰过的不算。
            </div>
          ) : (
            <>
              <div className="evolve-stat-line">
                用过或自己写的技艺 <b>{learned.length}</b> 条 ·
                记忆 <b>{graph.memory?.length ?? 0}</b> 段 ·
                互相牵连 <b>{graph.edges?.length ?? 0}</b> 处
              </div>
              {!!top.length && (
                <div className="evolve-chip-list">
                  {top.map((c) => (
                    <span key={c.category} className="evolve-chip">
                      {c.category} · {c.count}
                    </span>
                  ))}
                </div>
              )}
              <div className="evolve-compact-list">
                {learned.slice()
                  .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
                  .map((n) => (
                  <div key={n.id} className="evolve-compact-row">
                    <span className="evolve-compact-name">{n.label}</span>
                    {n.createdBy === "agent" && <span className="evolve-small-tag is-info">自学</span>}
                    {n.pinned && <span className="evolve-small-tag is-success">钉住</span>}
                    <span className="evolve-record-meta">用过 {n.useCount ?? 0}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>

        <Panel
          title="花了多少"
          actions={(
            <div className="evolve-segmented-actions" aria-label="用量统计周期">
              {[7, 30, 90].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  className={`evolve-secondary-button${days === d ? " is-active" : ""}`}
                  aria-pressed={days === d}
                >
                  {d} 天
                </button>
              ))}
            </div>
          )}
        >

          {loading && !usage ? (
            <div className="evolve-state-text">正在读取用量记录…</div>
          ) : loadErrors.includes("usage") && !usage ? (
            <div className="evolve-state-text is-error">用量记录读取失败，不能判断当前是否为空。</div>
          ) : !usage || daily.length === 0 ? (
            <div className="evolve-state-text">这段时间没有用量记录。</div>
          ) : (
            <>
              <div className="evolve-stat-line">
                对话 <b>{tot.sessions}</b> 次 · 请求 <b>{tot.calls}</b> 次
              </div>
              <div className="evolve-stat-line evolve-stat-line--secondary">
                读进 {approxTokens(tot.input)} · 写出 {approxTokens(tot.output)} ·
                缓存命中 <b className="is-success">{approxTokens(tot.cache)}</b>
              </div>
              {tot.cost > 0 && (
                <div className="evolve-cost-line">
                  约 <b>${tot.cost.toFixed(2)}</b>
                </div>
              )}
              {/* Cache reads are why the no-hot-swap rule is worth the
                  inconvenience — showing the number makes that concrete. */}
              {tot.cache > 0 && (
                <div className="evolve-explainer">
                  缓存命中的部分几乎不要钱 —— 这就是「改动等下次启动生效」换来的东西：
                  会话中途改提示词会把这块缓存全丢掉。
                </div>
              )}

              <div className="evolve-bar-chart" aria-label={`${days} 天 token 用量`}>
                {daily.slice(-30).map((d) => {
                  const v = (d.input_tokens || 0) + (d.output_tokens || 0);
                  const max = Math.max(...daily.map((x) => (x.input_tokens || 0) + (x.output_tokens || 0)), 1);
                  return (
                    <div
                      key={d.day}
                      className="evolve-bar-chart__bar"
                      title={`${d.day} · ${approxTokens(v)}`}
                      style={{ "--bar-height": `${Math.max(2, (v / max) * 100)}%` } as React.CSSProperties}
                    />
                  );
                })}
              </div>
              <div className="evolve-chart-range">
                {daily[0]?.day} → {daily[daily.length - 1]?.day}
              </div>
            </>
          )}

          {cal && cal.total > 0 && (
            <div className="evolve-subsection evolve-calibration">
              夜貘事先说会怎么变、事后核对：
              <span className={(cal.accuracy ?? 0) >= 0.6 ? "is-success" : "is-warning"}>
                {cal.verified}/{cal.total}
              </span>
            </div>
          )}
          {loadErrors.includes("calibration") && (
            <div className="evolve-subsection evolve-state-text is-error">
              夜貘判断准确率暂时读取失败。
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
