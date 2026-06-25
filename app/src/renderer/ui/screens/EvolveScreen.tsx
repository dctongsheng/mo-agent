import React, { useEffect, useState, useCallback } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { useAppState } from "../appState";
import { GrowthRings } from "../components/GrowthRings";
import { TapeCard } from "../components/TapeCard";
import { HarnessEvolve } from "./HarnessEvolve";
import {
  getEvolutionStats, listTrajectories, labelTrajectory, scheduleMolting,
  EvolutionStats, Trajectory,
} from "../../services/mo-api";

const NUMS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
const numCn = (n: number) => (n <= 12 ? NUMS[n] : String(n));

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function EvolveScreen() {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const { go } = useAppState();
  const [stats, setStats] = useState<EvolutionStats | null>(null);
  const [trajs, setTrajs] = useState<Trajectory[]>([]);
  const [trajOpen, setTrajOpen] = useState(false);
  const [scheduled, setScheduled] = useState(false);

  const refresh = useCallback(() => {
    if (!moPort) return;
    getEvolutionStats(moPort).then(setStats).catch(() => {});
    listTrajectories(moPort, 20).then((r) => setTrajs(r.data)).catch(() => {});
  }, [moPort]);

  useEffect(() => { refresh(); }, [refresh]);

  const label = (id: string, l: "pos" | "neg") => {
    if (!moPort) return;
    setTrajs((ts) => ts.map((t) => (t.id === id ? { ...t, label: l } : t)));
    labelTrajectory(moPort, id, l).then(() => {
      getEvolutionStats(moPort).then(setStats).catch(() => {});
    }).catch(() => refresh());
  };

  const schedule = () => {
    if (!moPort || scheduled) return;
    scheduleMolting(moPort, `手动安排 · ${trajs.length} 条轨迹待入药`).then(() => {
      setScheduled(true);
      refresh();
    }).catch(() => {});
  };

  const ringCount = stats?.molting_count ?? 0;
  const empty = stats != null && stats.task_count === 0;

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "44px 48px 90px" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.22em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>SELF-EVOLUTION · 自进化中心</div>
      <h1 style={{ margin: "12px 0 8px", fontFamily: "'Noto Serif SC', serif", fontSize: 28, fontWeight: 650, letterSpacing: "-0.01em" }}>
        {ringCount > 0 ? `第${numCn(ringCount)}环。它正在长成更懂你的样子。` : "还没添过环。一切从第一条轨迹开始。"}
      </h1>
      <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.7, color: "var(--ink-2)", maxWidth: 620 }}>
        每一项任务都被观察、制成标本;攒够了,就在梦里完成一次「蜕皮」。这页的数字全部来自本机真实记录。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 32, marginTop: 40, alignItems: "start" }}>
        {/* Growth rings */}
        <TapeCard tapeLeft={true} tapeRotate="-2.5deg" style={{ padding: "26px 24px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <GrowthRings count={Math.max(ringCount, 1)} />
          <div style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "center", lineHeight: 1.6 }}>
            生长环 · GROWTH RINGS<br />已蜕皮 {ringCount} 次
          </div>
        </TapeCard>

        {/* Stats summary */}
        <div>
          <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 14 }}>生长台账 · LEDGER</div>
          {empty ? (
            <div style={{ padding: "28px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontFamily: "'Long Cang', cursive", fontSize: 19, color: "var(--ink-2)" }}>台账还空着。</div>
              <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 6 }}>去工作台聊几句——每次对话都会留下一条轨迹标本。</div>
              <button onClick={() => go("home")} style={{ marginTop: 12, border: "none", background: "transparent", padding: 0, cursor: "pointer", fontSize: 13, color: "var(--indigo)" }}>去工作台 →</button>
            </div>
          ) : (
            <div>
              <LedgerRow k="轨迹标本" v={`${stats?.task_count ?? "…"} 条`} />
              <LedgerRow k="记忆标本" v={`${stats?.specimen_count ?? "…"} 条`} />
              <LedgerRow k="已标注 正例 / 负例" v={`${stats?.labeled_pos ?? 0} / ${stats?.labeled_neg ?? 0}`} />
              <LedgerRow k="标注成功率" v={stats?.success_rate != null ? `${Math.round(stats.success_rate * 100)}%` : "未标注"} />
              <LedgerRow k="上次蜕皮" v={stats?.last_molting ? fmtTime(stats.last_molting.at) : "还没有过"} last />
            </div>
          )}
        </div>
      </div>

      {/* 2-card grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26, marginTop: 40 }}>

        {/* Herbarium — real trajectories */}
        <TapeCard tapeLeft={true} tapeRotate="2.5deg" style={{ padding: "22px 24px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, fontWeight: 650 }}>训练数据 · 标本馆</span>
            <span style={{ fontSize: 9.5, letterSpacing: "0.16em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>HERBARIUM</span>
          </div>
          <div style={{ fontFamily: "'Long Cang', cursive", fontSize: 16, color: "var(--ink-2)", marginBottom: 14 }}>
            {stats ? `已制成 ${stats.task_count} 条轨迹标本。` : "清点中……"}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", borderTop: "1px dashed var(--line)", paddingTop: 10 }}>
            标本只存在本机 ~/.hermes-mo/trajectories,点 正/负 印章即可标注。
          </div>
          <button onClick={() => setTrajOpen((o) => !o)} style={linkBtn}>{trajOpen ? "收起标本 ▴" : "翻看标本 ▾"}</button>
          {trajOpen && (
            <div style={dataPanel}>
              {trajs.length === 0 && <span style={{ color: "var(--ink-3)" }}>还没有标本。</span>}
              {trajs.map((t) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {t.prompt.slice(0, 24)}{t.prompt.length > 24 ? "…" : ""}
                  </span>
                  <span style={{ color: "var(--ink-3)", flexShrink: 0 }}>{fmtTime(t.created_at)}</span>
                  <button
                    onClick={() => label(t.id, "pos")}
                    style={{ ...stampBtn, color: "var(--moss)", borderColor: "var(--moss)", opacity: t.label === "pos" ? 1 : 0.4 }}
                  >正</button>
                  <button
                    onClick={() => label(t.id, "neg")}
                    style={{ ...stampBtn, color: "var(--seal)", borderColor: "var(--seal)", opacity: t.label === "neg" ? 1 : 0.4 }}
                  >负</button>
                </div>
              ))}
            </div>
          )}
        </TapeCard>

        {/* Molting */}
        <TapeCard tapeLeft={false} tapeRotate="-2deg" style={{ padding: "22px 24px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, fontWeight: 650 }}>蜕皮 · 模型与骨架</span>
            <span style={{ fontSize: 9.5, letterSpacing: "0.16em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>MOLTING</span>
          </div>
          <div style={{ fontFamily: "'Long Cang', cursive", fontSize: 16, color: "var(--ink-2)", marginBottom: 14 }}>
            {ringCount > 0
              ? `已蜕皮 ${ringCount} 次,${stats?.last_molting ? `最近一次在 ${fmtTime(stats.last_molting.at)}` : ""}`
              : "还没蜕过皮。攒够标本,就可以安排第一次。"}
          </div>
          {stats?.last_molting && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "12px 14px", marginBottom: 10 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{stats.last_molting.note || "无备注"}</div>
              <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 3 }}>{fmtTime(stats.last_molting.at)}</div>
            </div>
          )}
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", borderTop: "1px dashed var(--line)", paddingTop: 10, lineHeight: 1.7 }}>
            真正的微调流水线(GRPO/LoRA)接入后,这个按钮会触发训练任务;现在它先记一笔蜕皮台账。
          </div>
          <button
            onClick={schedule}
            disabled={scheduled}
            style={{
              marginTop: 14, height: 38, width: "100%", borderRadius: 9, border: "none",
              background: scheduled ? "var(--line)" : "var(--seal)", color: "oklch(98% 0.01 85)",
              fontSize: 13.5, fontWeight: 600, cursor: scheduled ? "default" : "pointer",
              fontFamily: "'Noto Serif SC', serif",
            }}
          >{scheduled ? "已记入今夜梦中 ✓" : "安排下一次蜕皮 · 今夜梦中 →"}</button>
          <button onClick={() => go("dream")} style={{ ...linkBtn, marginTop: 10 }}>去看梦境 →</button>
        </TapeCard>
      </div>

      {/* Harness self-evolution (skills via GEPA) */}
      <HarnessEvolve />
    </div>
  );
}

function LedgerRow({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "13px 0", borderTop: "1px solid var(--line)",
      ...(last ? { borderBottom: "1px solid var(--line)" } : {}),
    }}>
      <span style={{ fontSize: 13.5 }}>{k}</span>
      <span style={{ fontSize: 14, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{v}</span>
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  marginTop: 12, border: "none", background: "transparent", padding: 0,
  cursor: "pointer", fontSize: 12.5, color: "var(--indigo)",
};

const dataPanel: React.CSSProperties = {
  marginTop: 12, border: "1px dashed var(--line-2)", borderRadius: 6,
  padding: "12px 14px", fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11.5, color: "var(--ink-2)",
  display: "flex", flexDirection: "column", gap: 8,
};

const stampBtn: React.CSSProperties = {
  width: 24, height: 24, flexShrink: 0, borderRadius: 3,
  border: "1.6px solid", background: "transparent",
  fontFamily: "'Noto Serif SC', serif", fontSize: 11, fontWeight: 600,
  cursor: "pointer", transform: "rotate(6deg)", padding: 0,
};
