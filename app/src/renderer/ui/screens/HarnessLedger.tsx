import React, { useCallback, useEffect, useState } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { TapeCard } from "../components/TapeCard";
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
export function HarnessLedger() {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const [graph, setGraph] = useState<LearningGraph | null>(null);
  const [usage, setUsage] = useState<UsageAnalytics | null>(null);
  const [cal, setCal] = useState<Calibration | null>(null);
  const [days, setDays] = useState(30);

  const refresh = useCallback(() => {
    if (!moPort) return;
    getLearningGraph(moPort).then(setGraph).catch(() => setGraph(null));
    getUsageAnalytics(moPort, days).then(setUsage).catch(() => setUsage(null));
    getCalibration(moPort).then(setCal).catch(() => {});
  }, [moPort, days]);

  useEffect(() => { refresh(); }, [refresh]);

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

  const btn: React.CSSProperties = { border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", borderRadius: 6, fontSize: 11.5, padding: "2px 9px", cursor: "pointer" };

  return (
    <div style={{ marginTop: 48 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>
        LEDGER · 学到了什么 · 花了多少
      </div>
      <h2 style={{ margin: "8px 0 6px", fontFamily: "'Noto Serif SC', serif", fontSize: 21, fontWeight: 650 }}>
        它到底学到了什么,又值不值。
      </h2>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: "var(--ink-2)", maxWidth: 660 }}>
        左边是它真正用过或自己写下的东西,右边是这些事花掉的钱。
        「夜貘的判断准确率」答的是准不准,这一页答的是值不值。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26, marginTop: 26, alignItems: "start" }}>
        <TapeCard tapeLeft={true} tapeRotate="2deg" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650, marginBottom: 12 }}>学到了什么</div>
          {!graph ? (
            <div style={{ fontSize: 13, color: "var(--ink-3)" }}>读不到学习图谱。</div>
          ) : learned.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.7 }}>
              还没有它用过或自己写下的技艺 —— 图谱只收这两类,内置但没碰过的不算。
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.9 }}>
                用过或自己写的技艺 <b>{learned.length}</b> 条 ·
                记忆 <b>{graph.memory?.length ?? 0}</b> 段 ·
                互相牵连 <b>{graph.edges?.length ?? 0}</b> 处
              </div>
              {!!top.length && (
                <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {top.map((c) => (
                    <span key={c.category} style={{ fontSize: 11, color: "var(--ink-2)",
                          border: "1px solid var(--line-2)", borderRadius: 99, padding: "2px 9px" }}>
                      {c.category} · {c.count}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 14, maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
                {learned.slice()
                  .sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0))
                  .map((n) => (
                  <div key={n.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12,
                                           fontFamily: "'JetBrains Mono', monospace", color: "var(--ink-2)" }}>
                    <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.label}</span>
                    {n.createdBy === "agent" && <span style={{ fontSize: 10, color: "var(--indigo)" }}>自学</span>}
                    {n.pinned && <span style={{ fontSize: 10, color: "var(--moss)" }}>钉住</span>}
                    <span style={{ fontSize: 11, color: "var(--ink-3)" }}>用过 {n.useCount ?? 0}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </TapeCard>

        <TapeCard tapeLeft={false} tapeRotate="-2deg" style={{ padding: "22px 24px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
            <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650 }}>花了多少</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {[7, 30, 90].map((d) => (
                <button key={d} onClick={() => setDays(d)} style={{
                  ...btn, ...(days === d ? { borderColor: "var(--seal)", color: "var(--seal)" } : {}),
                }}>{d} 天</button>
              ))}
            </span>
          </div>

          {!usage || daily.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--ink-3)" }}>这段时间没有用量记录。</div>
          ) : (
            <>
              <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.9 }}>
                对话 <b>{tot.sessions}</b> 次 · 请求 <b>{tot.calls}</b> 次
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.9, marginTop: 2 }}>
                读进 {approxTokens(tot.input)} · 写出 {approxTokens(tot.output)} ·
                缓存命中 <b style={{ color: "var(--moss)" }}>{approxTokens(tot.cache)}</b>
              </div>
              {tot.cost > 0 && (
                <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 4 }}>
                  约 <b>${tot.cost.toFixed(2)}</b>
                </div>
              )}
              {/* Cache reads are why the no-hot-swap rule is worth the
                  inconvenience — showing the number makes that concrete. */}
              {tot.cache > 0 && (
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.7 }}>
                  缓存命中的部分几乎不要钱 —— 这就是「改动等下次启动生效」换来的东西：
                  会话中途改提示词会把这块缓存全丢掉。
                </div>
              )}

              <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 56, marginTop: 14 }}>
                {daily.slice(-30).map((d) => {
                  const v = (d.input_tokens || 0) + (d.output_tokens || 0);
                  const max = Math.max(...daily.map((x) => (x.input_tokens || 0) + (x.output_tokens || 0)), 1);
                  return (
                    <div key={d.day} title={`${d.day} · ${approxTokens(v)}`} style={{
                      flex: 1, height: `${Math.max(2, (v / max) * 100)}%`,
                      background: "var(--indigo)", opacity: 0.55, borderRadius: 2,
                    }} />
                  );
                })}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>
                {daily[0]?.day} → {daily[daily.length - 1]?.day}
              </div>
            </>
          )}

          {cal && cal.total > 0 && (
            <div style={{ borderTop: "1px dashed var(--line)", marginTop: 14, paddingTop: 12,
                          fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.7 }}>
              夜貘事先说会怎么变、事后核对：
              <span style={{ fontFamily: "'JetBrains Mono', monospace", marginLeft: 4,
                             color: (cal.accuracy ?? 0) >= 0.6 ? "var(--moss)" : "var(--moon)" }}>
                {cal.verified}/{cal.total}
              </span>
            </div>
          )}
        </TapeCard>
      </div>
    </div>
  );
}
