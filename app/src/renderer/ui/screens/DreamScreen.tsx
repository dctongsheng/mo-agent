import React, { useEffect, useState } from "react";
import { useAppState } from "../appState";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { Doll } from "../components/Doll";
import { TapeCard } from "../components/TapeCard";
import { Toggle } from "../components/Toggle";
import { getEvolutionStats, EvolutionStats } from "../../services/mo-api";

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function DreamScreen() {
  const s = useAppState();
  const moPort = useAppSelector((st) => moPortOf(st.gateway.state));
  const [stats, setStats] = useState<EvolutionStats | null>(null);

  useEffect(() => {
    if (!moPort) return;
    getEvolutionStats(moPort).then(setStats).catch(() => {});
  }, [moPort]);

  const dreamItems = stats ? [
    {
      label: "归档",
      detail: stats.task_count > 0
        ? `白天经手 ${stats.task_count} 条轨迹,已制成标本入训练集。`
        : "白天没有新轨迹,今晚没什么可归档的。",
      opacity: 1,
    },
    {
      label: "巩固",
      detail: stats.specimen_count > 0
        ? `墙上贴着 ${stats.specimen_count} 条记忆标本,常翻的会加深。`
        : "记忆墙还空着,先去记忆室贴几条。",
      opacity: 0.75,
    },
    {
      label: "标注",
      detail: (stats.labeled_pos + stats.labeled_neg) > 0
        ? `已有 ${stats.labeled_pos} 条正例、${stats.labeled_neg} 条负例,等着入药。`
        : "还没有标注过的轨迹——去进化中心盖几个章。",
      opacity: 0.55,
    },
    ...(stats.last_molting ? [{
      label: "蜕皮",
      detail: `${fmtTime(stats.last_molting.at)} 记下第 ${stats.molting_count} 次蜕皮:${stats.last_molting.note || "无备注"}`,
      opacity: 1,
      isSeal: true,
    }] : []),
  ] : [];

  return (
    <div style={{ maxWidth: 1020, margin: "0 auto", padding: "44px 48px 90px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <svg width="34" height="34" viewBox="0 0 34 34">
          <path d="M 26 21 A 11 11 0 1 1 13 4 A 9.5 9.5 0 0 0 26 21 Z" fill="var(--moon)" opacity="0.92" />
        </svg>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.22em", color: "var(--moon)", fontFamily: "'JetBrains Mono', monospace" }}>DREAMING · 梦境</div>
          <h1 style={{ margin: "6px 0 0", fontFamily: "'Noto Serif SC', serif", fontSize: 28, fontWeight: 650, letterSpacing: "-0.01em" }}>凌晨两点,它开始做梦。</h1>
        </div>
      </div>
      <p style={{ margin: "14px 0 0", fontSize: 14.5, lineHeight: 1.7, color: "var(--ink-2)", maxWidth: 640 }}>
        梦不是休眠。空闲时它离线消化白天的任务、巩固与淡忘记忆、把零散的事连成线——醒来给你一份梦境报告。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "312px 1fr", gap: 32, marginTop: 40, alignItems: "start" }}>
        {/* Left: sleeping doll + settings */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18, position: "sticky", top: 44 }}>
          <TapeCard tapeLeft={true} tapeRotate="-2deg" style={{ padding: "30px 22px 22px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <Doll form={s.dollForm} sleeping />
            <div style={{ fontFamily: "'Long Cang', cursive", fontSize: 17, color: "var(--ink-2)" }}>睡着了 · 请勿吵醒</div>
            <div style={{ fontSize: 10.5, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>REM · consolidating</div>
          </TapeCard>

          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 4, padding: "18px 20px", boxShadow: "var(--shadow)", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>梦境设置 · RITUAL</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13.5 }}>允许做梦</span>
              <Toggle on={s.dreamOn} onChange={s.toggleDream} />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13.5 }}>时间窗</span>
              <span style={{ fontSize: 12.5, fontFamily: "'JetBrains Mono', monospace", color: "var(--ink-2)" }}>02:00 – 06:00</span>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.6 }}>只在接通电源且空闲时进行;梦中一切可回滚。</div>
          </div>
        </div>

        {/* Right: dream report + morning note */}
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <TapeCard tapeLeft={false} tapeRotate="2deg" style={{ padding: "24px 26px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18 }}>
              <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, fontWeight: 650 }}>梦境报告</span>
              <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>基于本机真实台账</span>
            </div>
            {dreamItems.length === 0 && (
              <div style={{ padding: "20px 0", fontSize: 13, color: "var(--ink-3)" }}>
                今晚还没有梦。去工作台聊几句,给它一些可以梦的素材。
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column" }}>
              {dreamItems.map((item: any, i) => (
                <div key={i} style={{ display: "flex", gap: 16, padding: i < dreamItems.length - 1 ? "13px 0" : "13px 0 2px", borderTop: "1px dashed var(--line)" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: item.isSeal ? "var(--seal)" : "var(--moon)", opacity: item.opacity, marginTop: 5, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{item.label}</div>
                    <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 3, lineHeight: 1.6 }}>{item.detail}</div>
                    {item.isSeal && (
                      <button onClick={() => s.goEvolve("overview")} style={{ marginTop: 6, border: "none", background: "transparent", padding: 0, cursor: "pointer", fontSize: 12, color: "var(--indigo)" }}>去进化中心看这一环 →</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </TapeCard>

          <TapeCard tapeLeft={true} tapeRotate="-2.5deg" style={{ padding: "24px 26px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>醒来的话 · MORNING NOTE</span>
              <span style={{ fontSize: 9.5, color: "var(--moon)", border: "1px dashed var(--moon)", borderRadius: 3, padding: "1px 5px" }}>示例</span>
            </div>
            <div style={{ fontFamily: "'Long Cang', cursive", fontSize: 21, lineHeight: 1.6, color: "var(--ink)" }}>
              「我梦见你每周五都在找上周的文件。要不要以后周五早上,我先把它们备好放在桌面?」
            </div>
            {s.dreamAnswer === null ? (
              <div style={{ display: "flex", gap: 12, marginTop: 18 }}>
                <button onClick={s.acceptDream} style={{ height: 40, padding: "0 20px", borderRadius: 9, border: "none", background: "var(--seal)", color: "oklch(98% 0.01 85)", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Serif SC', serif" }}>好啊,就这么办</button>
                <button onClick={s.declineDream} style={{ height: 40, padding: "0 20px", borderRadius: 9, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", fontSize: 13.5, cursor: "pointer" }}>先不用</button>
              </div>
            ) : (
              <div style={{ marginTop: 16, fontSize: 13.5, color: s.dreamAnswer === "yes" ? "var(--moss)" : "var(--ink-3)" }}>
                {s.dreamAnswer === "yes" ? "✓ 已记下这个习惯(联想引擎接入后会自动执行)。" : "好,这个梦先收起来,不打扰你。"}
              </div>
            )}
          </TapeCard>
        </div>
      </div>
    </div>
  );
}
