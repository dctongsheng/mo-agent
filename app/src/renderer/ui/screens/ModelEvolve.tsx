import React, { useEffect, useState, useCallback } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { TapeCard } from "../components/TapeCard";
import {
  getFinetuneStatus, runFinetune, listFinetuneRuns, getFinetuneRunLog,
  FinetuneStatus, FinetuneRun,
} from "../../services/mo-api";

function fmt(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const SLABEL: Record<string, string> = { running: "微调中…", done: "完成", failed: "失败" };
const SCOLOR: Record<string, string> = { running: "var(--moon)", done: "var(--moss)", failed: "var(--seal)" };

/** 模型自进化 · 权重微调 — gated on datasets-ready + local-model-active. */
export function ModelEvolve({ onGoSettings }: { onGoSettings: () => void }) {
  const moPort = useAppSelector((st) => moPortOf(st.gateway.state));
  const [status, setStatus] = useState<FinetuneStatus | null>(null);
  const [runs, setRuns] = useState<FinetuneRun[]>([]);
  const [steps, setSteps] = useState(10);
  const [busy, setBusy] = useState(false);
  const [logRun, setLogRun] = useState<FinetuneRun | null>(null);
  const [logText, setLogText] = useState("");

  const refresh = useCallback(() => {
    if (!moPort) return;
    getFinetuneStatus(moPort).then(setStatus).catch(() => {});
    listFinetuneRuns(moPort).then((r) => setRuns(r.data)).catch(() => {});
  }, [moPort]);
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!moPort) return;
    if (!runs.some((r) => r.status === "running")) return;
    const t = setInterval(() => listFinetuneRuns(moPort).then((r) => setRuns(r.data)).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [moPort, runs]);

  const start = () => {
    if (!moPort || !status?.can_start || busy) return;
    setBusy(true);
    runFinetune(moPort, "sft", steps).then((r) => {
      if (!r.ok) alert(`无法开始：${r.reason ?? "未知"}`);
      setTimeout(refresh, 500);
    }).catch(() => {}).finally(() => setBusy(false));
  };

  const openLog = (run: FinetuneRun) => {
    if (!moPort) return;
    setLogRun(run); setLogText("加载中…");
    getFinetuneRunLog(moPort, run.id).then((r) => setLogText(r.data || "(日志为空)")).catch(() => setLogText("(读取失败)"));
  };
  useEffect(() => {
    if (!moPort || !logRun) return;
    const live = (runs.find((r) => r.id === logRun.id)?.status ?? logRun.status) === "running";
    if (!live) return;
    const t = setInterval(() => getFinetuneRunLog(moPort, logRun.id).then((r) => setLogText(r.data || "")).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [moPort, logRun, runs]);

  const Gate = ({ ok, label }: { ok: boolean; label: string }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <span style={{ width: 16, height: 16, borderRadius: 99, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: ok ? "var(--moss)" : "var(--line-2)", color: "#fff", fontSize: 11 }}>{ok ? "✓" : "·"}</span>
      <span style={{ color: ok ? "var(--ink)" : "var(--ink-3)" }}>{label}</span>
    </div>
  );

  return (
    <div style={{ marginTop: 26 }}>
      <TapeCard tapeLeft={true} tapeRotate="-1.5deg" style={{ padding: "20px 24px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650 }}>模型自进化 · 权重微调</span>
          <span style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>MODEL · LoRA/GRPO</span>
          {status && (
            <span style={{ marginLeft: "auto", fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace", color: status.mode === "real" ? "var(--moss)" : "var(--moon)", border: `1px solid ${status.mode === "real" ? "var(--moss)" : "var(--moon)"}`, borderRadius: 99, padding: "2px 9px" }}>
              {status.mode === "real" ? "可真训练" : "脚手架"}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", margin: "8px 0 14px", lineHeight: 1.7 }}>
          用攒下的对话轨迹给本地模型做 LoRA 微调,真正改写权重。需满足两个开启条件:
        </div>

        {/* gates */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", border: "1px dashed var(--line-2)", borderRadius: 8 }}>
          <Gate ok={!!status?.datasets_ready} label={status ? `训练数据就绪(训练 ${status.train_rows}/${status.min_train_rows} · 测试 ${status.test_rows})` : "训练数据"} />
          <Gate ok={!!status?.local_active} label={status?.local_active ? `使用本地模型对话(${status.current_model})` : "使用本地模型对话"} />
        </div>

        {status && (
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 10, lineHeight: 1.6 }}>
            后端:{status.backend_reason}{status.mode === "scaffold" ? " · 未配置 MinT key,当前为脚手架(只打印将执行的命令)。" : ""}
          </div>
        )}

        {!status?.can_start && (
          <button onClick={onGoSettings} style={{ marginTop: 12, border: "none", background: "transparent", padding: 0, cursor: "pointer", fontSize: 13, color: "var(--indigo)" }}>
            去设置配置数据集 / 启用本地模型 →
          </button>
        )}

        {status?.can_start && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
            <label style={{ fontSize: 12, color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 8 }}>
              步数 · {steps}
              <input type="range" min={1} max={100} value={steps} onChange={(e) => setSteps(Number(e.target.value))} style={{ width: 120 }} />
            </label>
            <button onClick={start} disabled={busy} style={{
              height: 38, padding: "0 20px", borderRadius: 9, border: "none",
              background: busy ? "var(--line)" : "var(--seal)", color: "oklch(98% 0.01 85)",
              fontSize: 14, fontWeight: 600, cursor: busy ? "default" : "pointer", fontFamily: "'Noto Serif SC', serif",
            }}>{busy ? "启动中…" : "开始微调 →"}</button>
          </div>
        )}

        {/* runs */}
        {runs.length > 0 && (
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, letterSpacing: "0.16em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>微调记录</div>
            {runs.slice(0, 8).map((r) => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--card)" }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: SCOLOR[r.status] ?? "var(--ink-3)", flexShrink: 0, ...(r.status === "running" ? { animation: "breathe 1.4s ease-in-out infinite" } : {}) }} />
                <span style={{ flex: 1, fontSize: 12.5, fontFamily: "'JetBrains Mono', monospace" }}>{r.method.toUpperCase()} · {r.steps} 步{r.scaffold ? " · 脚手架" : ""}</span>
                <span style={{ fontSize: 11, color: SCOLOR[r.status] ?? "var(--ink-3)" }}>{SLABEL[r.status] ?? r.status}</span>
                <button onClick={() => openLog(r)} style={{ flexShrink: 0, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", borderRadius: 6, fontSize: 11, padding: "2px 8px", cursor: "pointer" }}>日志</button>
                <span style={{ fontSize: 11, color: "var(--ink-3)", flexShrink: 0 }}>{fmt(r.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </TapeCard>

      {/* Log modal */}
      {logRun && (
        <div onClick={() => setLogRun(null)} style={{ position: "fixed", inset: 0, background: "oklch(20% 0.02 60 / 0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 51, padding: 40 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--card)", borderRadius: 12, boxShadow: "var(--shadow)", width: "min(900px, 94vw)", maxHeight: "86vh", display: "flex", flexDirection: "column", border: "1px solid var(--line)" }}>
            <div style={{ padding: "16px 22px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650 }}>微调日志</span>
              {(runs.find((r) => r.id === logRun.id)?.status ?? logRun.status) === "running" && <span style={{ fontSize: 11, color: "var(--moon)" }}>● 实时刷新中</span>}
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
