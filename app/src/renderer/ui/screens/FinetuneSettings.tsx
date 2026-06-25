import React, { useEffect, useState, useCallback } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import {
  getLocalStatus, listLocalModels, pullLocalModel, useLocalModel,
  getFinetuneConfig, setFinetuneConfig, genFinetuneDataset,
  LocalStatus, LocalModel, FinetuneConfig,
} from "../../services/mo-api";

function fmtSize(b: number): string {
  if (!b) return "";
  const gb = b / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(b / 1e6)}MB`;
}

/** 本地灶台 + 微调数据集 — the two Settings sections that gate model fine-tuning. */
export function FinetuneSettings() {
  const moPort = useAppSelector((st) => moPortOf(st.gateway.state));
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [pullName, setPullName] = useState("qwen2.5:0.5b");
  const [pulling, setPulling] = useState(false);
  const [cfg, setCfg] = useState<FinetuneConfig | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState("");

  const refresh = useCallback(() => {
    if (!moPort) return;
    getLocalStatus(moPort).then(setLocal).catch(() => {});
    listLocalModels(moPort).then((r) => setModels(r.data)).catch(() => {});
    getFinetuneConfig(moPort).then(setCfg).catch(() => {});
  }, [moPort]);

  useEffect(() => { refresh(); }, [refresh]);
  // poll while pulling (model list grows when done)
  useEffect(() => {
    if (!moPort || !pulling) return;
    const t = setInterval(() => listLocalModels(moPort).then((r) => setModels(r.data)).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [moPort, pulling]);

  const doPull = () => {
    if (!moPort || !pullName.trim()) return;
    setPulling(true);
    pullLocalModel(moPort, pullName.trim()).then((r) => {
      if (!r.ok) { alert(`拉取失败：${r.reason ?? "未知"}`); setPulling(false); }
    }).catch(() => setPulling(false));
  };

  const doUse = (model: string) => {
    if (!moPort) return;
    setBusy(model);
    useLocalModel(moPort, model).then((r) => {
      if (r.ok) setTimeout(refresh, 600);
    }).catch(() => {}).finally(() => setBusy(""));
  };

  const saveCfg = (patch: Partial<{ train_path: string; test_path: string; mint_api_key: string }>) => {
    if (!moPort) return;
    setFinetuneConfig(moPort, patch).then(setCfg).catch(() => {});
  };

  const genDataset = () => {
    if (!moPort) return;
    setBusy("gen");
    genFinetuneDataset(moPort).then((r) => {
      if (!r.ok) alert(`生成失败：${r.reason ?? "未知"}`);
      getFinetuneConfig(moPort).then(setCfg).catch(() => {});
    }).catch(() => {}).finally(() => setBusy(""));
  };

  return (
    <>
      {/* 本地灶台 — Ollama */}
      <div style={{ marginTop: 40 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>本地灶台 · LOCAL MODELS</span>
          {local && (
            <span style={{ fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace", color: local.running ? "var(--moss)" : "var(--moon)", display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${local.running ? "var(--moss)" : "var(--moon)"}`, borderRadius: 99, padding: "2px 9px" }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: "currentColor" }} />
              {local.installed ? (local.running ? "Ollama 在跑" : "Ollama 已装·未启动") : "未安装 Ollama"}
            </span>
          )}
        </div>

        {local && !local.installed && (
          <div style={{ background: "var(--card)", border: "1px dashed var(--line-2)", borderRadius: 10, padding: "18px", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.7 }}>
            未检测到 Ollama。装一个就能用本地模型对话:<br />
            <code style={code}>brew install ollama && ollama serve</code>
          </div>
        )}

        {local?.installed && (
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "16px 18px", boxShadow: "var(--shadow)" }}>
            {models.length === 0 && (
              <div style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 12 }}>还没有本地模型。拉一个小的试试(约 400MB)。</div>
            )}
            {models.map((m) => {
              const active = local.local_active && local.current_model === m.name;
              return (
                <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderTop: "1px dashed var(--line)" }}>
                  <span style={{ flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>{m.name}</span>
                  <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{fmtSize(m.size)}</span>
                  {active ? (
                    <span style={{ fontSize: 11, color: "var(--moss)", border: "1px solid var(--moss)", borderRadius: 99, padding: "2px 9px" }}>对话中</span>
                  ) : (
                    <button onClick={() => doUse(m.name)} disabled={busy === m.name} style={miniBtn}>{busy === m.name ? "切换中…" : "设为对话模型"}</button>
                  )}
                </div>
              );
            })}
            <div style={{ display: "flex", gap: 10, marginTop: 14, borderTop: "1px dashed var(--line)", paddingTop: 14 }}>
              <input value={pullName} onChange={(e) => setPullName(e.target.value)} placeholder="qwen2.5:0.5b" style={inp} />
              <button onClick={doPull} disabled={pulling} style={{ ...miniBtn, background: pulling ? "var(--line)" : "var(--seal)", color: "oklch(98% 0.01 85)", border: "none" }}>{pulling ? "拉取中…" : "拉取"}</button>
            </div>
            {pulling && <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8 }}>正在后台下载,完成后会出现在上面列表里。</div>}
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.6 }}>
              「设为对话模型」会把工作台的对话切到这只本地模型——新会话生效。模型自进化(微调)需要正在用本地模型。
            </div>
          </div>
        )}
      </div>

      {/* 微调数据集 */}
      <div style={{ marginTop: 40 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>微调数据集 · FINE-TUNE DATA</span>
          {cfg && (
            <span style={{ fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace", color: cfg.datasets_ready ? "var(--moss)" : "var(--moon)", display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${cfg.datasets_ready ? "var(--moss)" : "var(--moon)"}`, borderRadius: 99, padding: "2px 9px" }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: "currentColor" }} />
              {cfg.datasets_ready ? "已就绪" : `需训练集 ≥ ${cfg.min_train_rows}`}
            </span>
          )}
        </div>
        {cfg && (
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "16px 18px", boxShadow: "var(--shadow)", display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label={`训练集 JSONL · ${cfg.train_rows} 行${cfg.train_rows >= cfg.min_train_rows ? " ✓" : ` (需≥${cfg.min_train_rows})`}`}
              value={cfg.train_path} onSave={(v) => saveCfg({ train_path: v })} placeholder="/path/to/train.jsonl" />
            <Field label={`测试集 JSONL · ${cfg.test_rows} 行${cfg.test_rows > 0 ? " ✓" : ""}`}
              value={cfg.test_path} onSave={(v) => saveCfg({ test_path: v })} placeholder="/path/to/test.jsonl" />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button onClick={genDataset} disabled={busy === "gen"} style={{ ...miniBtn }}>{busy === "gen" ? "生成中…" : "从轨迹生成数据集"}</button>
              <span style={{ fontSize: 11, color: "var(--ink-3)" }}>把工作台攒下的对话转成 SFT {`{prompt, completion}`} 训练集。</span>
            </div>
            <div style={{ borderTop: "1px dashed var(--line)", paddingTop: 12 }}>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 6 }}>MinT API Key · {cfg.mint_api_key_set ? "已配置 ✓" : "未配置(留空则为脚手架模式)"}</div>
              <div style={{ display: "flex", gap: 10 }}>
                <input value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} type="password" placeholder="sk-…(macaron.im MinT)" style={inp} />
                <button onClick={() => { saveCfg({ mint_api_key: keyDraft.trim() }); setKeyDraft(""); }} disabled={!keyDraft.trim()} style={{ ...miniBtn, background: keyDraft.trim() ? "var(--seal)" : "var(--line)", color: "oklch(98% 0.01 85)", border: "none" }}>保存</button>
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.6 }}>
                真正发起云上 LoRA 训练需要 MinT key(macaron.im)。不填则微调只走脚手架(打印将执行的命令)。
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Field({ label, value, onSave, placeholder }: { label: string; value: string; onSave: (v: string) => void; placeholder: string }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--ink-3)" }}>
      {label}
      <div style={{ display: "flex", gap: 8 }}>
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} style={inp}
          onBlur={() => { if (v !== value) onSave(v); }}
          onKeyDown={(e) => { if (e.key === "Enter" && v !== value) onSave(v); }} />
      </div>
    </label>
  );
}

const inp: React.CSSProperties = { flex: 1, height: 36, borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--bg-2)", color: "var(--ink)", fontSize: 12.5, padding: "0 12px", fontFamily: "'JetBrains Mono', monospace", outline: "none" };
const miniBtn: React.CSSProperties = { height: 32, padding: "0 14px", borderRadius: 8, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", fontSize: 12.5, cursor: "pointer", flexShrink: 0, fontFamily: "'Noto Serif SC', serif" };
const code: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 12, background: "var(--bg-2)", border: "1px solid var(--line)", borderRadius: 5, padding: "2px 6px", display: "inline-block", marginTop: 6 };
