import React, { useEffect, useState, useCallback } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import {
  listEndpoints, addEndpoint, updateEndpoint, deleteEndpoint, detectEndpointModels,
  getEmbeddingConfig, setEmbeddingConfig, getEvolveModelConfig, setEvolveModelConfig,
  getFinetuneConfig, setFinetuneConfig, getMainModel, setMainModel,
  Endpoint, EmbeddingSel, EvolveSel, FinetuneConfig, MainModelSel,
} from "../../services/mo-api";

/** 模型配置 — endpoint library (configure once) + per-use model selection. */
export function ModelConfigSettings() {
  const moPort = useAppSelector((st) => moPortOf(st.gateway.state));
  const [eps, setEps] = useState<Endpoint[]>([]);
  const [emb, setEmb] = useState<EmbeddingSel | null>(null);
  const [evo, setEvo] = useState<EvolveSel | null>(null);
  const [ft, setFt] = useState<FinetuneConfig | null>(null);
  const [main, setMain] = useState<MainModelSel | null>(null);
  const [saved, setSaved] = useState("");
  const [adding, setAdding] = useState(false);
  const [detecting, setDetecting] = useState("");

  const refresh = useCallback(() => {
    if (!moPort) return;
    listEndpoints(moPort).then((r) => setEps(r.data)).catch(() => {});
    getEmbeddingConfig(moPort).then(setEmb).catch(() => {});
    getEvolveModelConfig(moPort).then(setEvo).catch(() => {});
    getFinetuneConfig(moPort).then(setFt).catch(() => {});
    getMainModel(moPort).then(setMain).catch(() => {});
  }, [moPort]);
  useEffect(() => { refresh(); }, [refresh]);

  const flash = (m: string) => { setSaved(m); setTimeout(() => setSaved(""), 3000); };

  const detect = (id: string) => {
    if (!moPort) return;
    setDetecting(id);
    detectEndpointModels(moPort, id).then((r) => {
      if (!r.ok) alert(`检测失败：${r.reason ?? "未知"}`);
      refresh();
    }).catch(() => {}).finally(() => setDetecting(""));
  };

  const epName = (id: string) => eps.find((e) => e.id === id)?.name ?? "(未选)";
  const epModels = (id: string) => eps.find((e) => e.id === id)?.models ?? [];

  return (
    <div style={{ marginTop: 40 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>模型配置 · MODELS</span>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>端点配一次,各处只选模型</span>
        {saved && <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--moss)" }}>{saved}</span>}
      </div>

      {/* Endpoint library */}
      <Card title="端点库 · ENDPOINTS" sub="OpenAI 兼容端点(Base URL + Key + 模型),配一次,下面各处复用">
        {eps.length === 0 && <div style={{ fontSize: 13, color: "var(--ink-3)" }}>还没有端点。添加一个(如 tokendance)。</div>}
        {eps.map((e) => (
          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px dashed var(--line)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{e.name} <span style={{ fontSize: 11, color: e.api_key_set ? "var(--moss)" : "var(--moon)" }}>· {e.api_key_set ? "key ✓" : "无 key"}</span></div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.base_url} · {e.models.length} 模型</div>
            </div>
            <button onClick={() => detect(e.id)} disabled={detecting === e.id} style={miniBtn}>{detecting === e.id ? "检测中…" : "检测模型"}</button>
            <button onClick={() => { if (moPort && confirm(`删除端点 ${e.name}?`)) deleteEndpoint(moPort, e.id).then((r) => setEps(r.data)); }} style={{ ...miniBtn, color: "var(--seal)", borderColor: "var(--seal)" }}>删除</button>
          </div>
        ))}
        {adding ? (
          <AddEndpoint onCancel={() => setAdding(false)} onAdd={(e) => {
            if (!moPort) return;
            addEndpoint(moPort, e).then((r) => { setEps(r.data); setAdding(false); flash("已添加端点"); });
          }} />
        ) : (
          <button onClick={() => setAdding(true)} style={{ ...miniBtn, marginTop: 12, background: "var(--seal)", color: "oklch(98% 0.01 85)", border: "none" }}>＋ 添加端点</button>
        )}
      </Card>

      {/* Main chat model — the one 小貘 actually talks with */}
      <Card title="对话模型 · 小貘" sub="小貘用来跟你说话的模型(选端点+模型)">
        {main && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <SelRow label="端点" value={main.endpoint_id} options={eps.map((e) => ({ v: e.id, t: e.name }))}
                onChange={(v) => {
                  const first = epModels(v)[0] ?? "";
                  if (moPort && first) setMainModel(moPort, v, first).then(setMain).then(() => flash("已保存 · 下次启动生效"));
                }} />
              <SelRow label="模型" value={main.model} options={epModels(main.endpoint_id).map((m) => ({ v: m, t: m }))}
                onChange={(v) => moPort && setMainModel(moPort, main.endpoint_id, v).then(setMain).then(() => flash("已保存 · 下次启动生效"))} />
            </div>
            {!main.endpoint_id && (
              <Note>
                当前模型 <b>{main.model || "(未设)"}</b> 来自 <code>{main.provider || "未知"}</code>,
                不在端点库里 —— 在上面选一个端点就会切过来。
              </Note>
            )}
            <Note>
              端点库里的端点会同步成 Hermes 的 provider,所以在「灶台」里也能直接挑到。
              换完模型要重启引擎才生效。
            </Note>
          </>
        )}
      </Card>

      {/* Embedding — pick endpoint + model */}
      <Card title="Embedding 模型 · 记忆室" sub="OpenViking 语义记忆的向量模型(选端点+模型即可)">
        {emb && (
          <>
            <SelRow label="端点" value={emb.endpoint_id} options={eps.map((e) => ({ v: e.id, t: e.name }))}
              onChange={(v) => moPort && setEmbeddingConfig(moPort, { endpoint_id: v, model: epModels(v)[0] ?? "", vlm_model: epModels(v)[0] ?? "", dimension: emb.dimension }).then(setEmb).then(() => flash("已保存"))} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 90px", gap: 12 }}>
              <SelRow label="Embedding 模型" value={emb.model} options={epModels(emb.endpoint_id).map((m) => ({ v: m, t: m }))}
                onChange={(v) => moPort && setEmbeddingConfig(moPort, { endpoint_id: emb.endpoint_id, model: v, vlm_model: emb.vlm_model, dimension: emb.dimension }).then(setEmb).then(() => flash("已保存"))} />
              <SelRow label="VLM 模型(图文)" value={emb.vlm_model} options={epModels(emb.endpoint_id).map((m) => ({ v: m, t: m }))}
                onChange={(v) => moPort && setEmbeddingConfig(moPort, { endpoint_id: emb.endpoint_id, model: emb.model, vlm_model: v, dimension: emb.dimension }).then(setEmb).then(() => flash("已保存"))} />
              <NumRow label="维度" value={emb.dimension}
                onChange={(v) => moPort && setEmbeddingConfig(moPort, { endpoint_id: emb.endpoint_id, model: emb.model, vlm_model: emb.vlm_model, dimension: v }).then(setEmb).then(() => flash("已保存"))} />
            </div>
            <Note>当前端点:{epName(emb.endpoint_id)}。改完请重启应用让 OpenViking 重载 embedding。</Note>
          </>
        )}
      </Card>

      {/* Skills evolution — pick endpoint + optimizer + eval */}
      <Card title="自进化模型 · 技艺(GEPA)" sub="skills 自进化的评测/反思模型(选端点+模型)">
        {evo && (
          <>
            <SelRow label="端点" value={evo.endpoint_id} options={eps.map((e) => ({ v: e.id, t: e.name }))}
              onChange={(v) => moPort && setEvolveModelConfig(moPort, { endpoint_id: v, optimizer_model: epModels(v)[0] ?? "", eval_model: epModels(v)[0] ?? "" }).then(setEvo).then(() => flash("已保存"))} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <SelRow label="优化器 optimizer" value={evo.optimizer_model} options={epModels(evo.endpoint_id).map((m) => ({ v: m, t: m }))}
                onChange={(v) => moPort && setEvolveModelConfig(moPort, { optimizer_model: v }).then(setEvo).then(() => flash("已保存"))} />
              <SelRow label="评测 eval" value={evo.eval_model} options={epModels(evo.endpoint_id).map((m) => ({ v: m, t: m }))}
                onChange={(v) => moPort && setEvolveModelConfig(moPort, { eval_model: v }).then(setEvo).then(() => flash("已保存"))} />
              <SelRow label="审查 critic" value={evo.critic_model} options={epModels(evo.endpoint_id).map((m) => ({ v: m, t: m }))}
                onChange={(v) => moPort && setEvolveModelConfig(moPort, { critic_model: v }).then(setEvo).then(() => flash("已保存"))} />
              <SelRow label="反思 reflect" value={evo.reflect_model} options={epModels(evo.endpoint_id).map((m) => ({ v: m, t: m }))}
                onChange={(v) => moPort && setEvolveModelConfig(moPort, { reflect_model: v }).then(setEvo).then(() => flash("已保存"))} />
            </div>
            {evo.critic_model === evo.optimizer_model && (
              <Note>⚠ 审查模型和优化模型相同 —— 同一个模型有同样的盲点,让它审自己的改写只会盖章。换成另一个,交叉审查才有意义。</Note>
            )}
            <Note>端点的 Base URL + Key 自动复用——不必再填。当前:{epName(evo.endpoint_id)}。</Note>
          </>
        )}
      </Card>

      {/* MinT fine-tune key */}
      <Card title="微调密钥 · MinT(云训练)" sub="模型自进化(LoRA/GRPO)用的 macaron.im MinT API key">
        {ft && (
          <>
            <KeyField label={`MinT API Key · ${ft.mint_api_key_set ? "已配置 ✓" : "未配置(留空则微调走脚手架)"}`} onSave={(v) => moPort && setFinetuneConfig(moPort, { mint_api_key: v }).then(setFt).then(() => flash("已保存"))} placeholder="sk-…(macaron.im)" />
            <Note>grpo 需 NVIDIA CUDA,本机仅支持 MinT 云训练。基座模型用本地灶台里设的本地模型。</Note>
          </>
        )}
      </Card>
    </div>
  );
}

function AddEndpoint({ onAdd, onCancel }: { onAdd: (e: { name: string; base_url: string; api_key: string }) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [key, setKey] = useState("");
  return (
    <div style={{ marginTop: 12, padding: "12px 14px", border: "1px dashed var(--line-2)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称 如 tokendance" style={inp} />
        <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="Base URL 如 https://…/v1" style={inp} />
      </div>
      <input value={key} type="password" onChange={(e) => setKey(e.target.value)} placeholder="API Key sk-…" style={inp} />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={miniBtn}>取消</button>
        <button onClick={() => name.trim() && base.trim() && onAdd({ name: name.trim(), base_url: base.trim(), api_key: key.trim() })} disabled={!name.trim() || !base.trim()} style={{ ...miniBtn, background: name.trim() && base.trim() ? "var(--seal)" : "var(--line)", color: "oklch(98% 0.01 85)", border: "none" }}>添加(之后可「检测模型」)</button>
      </div>
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "16px 18px", boxShadow: "var(--shadow)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 650, fontFamily: "'Noto Serif SC', serif" }}>{title}</span>
        <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{sub}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

function SelRow({ label, value, options, onChange }: { label: string; value: string; options: { v: string; t: string }[]; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--ink-3)" }}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} style={sel}>
        {!options.some((o) => o.v === value) && <option value={value}>{value || "(未选)"}</option>}
        {options.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
      </select>
    </label>
  );
}

function NumRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--ink-3)" }}>
      {label}
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { const n = Number(v) || 1024; if (n !== value) onChange(n); }} style={inp} />
    </label>
  );
}

function KeyField({ label, onSave, placeholder }: { label: string; onSave: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState("");
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--ink-3)" }}>
      {label}
      <div style={{ display: "flex", gap: 8 }}>
        <input value={v} type="password" onChange={(e) => setV(e.target.value)} placeholder={placeholder ?? "sk-…(留空不改)"} style={inp} />
        <button onClick={() => { if (v.trim()) { onSave(v.trim()); setV(""); } }} disabled={!v.trim()} style={{ ...miniBtn, background: v.trim() ? "var(--seal)" : "var(--line)", color: "oklch(98% 0.01 85)", border: "none" }}>保存</button>
      </div>
    </label>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.6, marginTop: 2 }}>{children}</div>;
}

const inp: React.CSSProperties = { flex: 1, height: 36, borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--bg-2)", color: "var(--ink)", fontSize: 12.5, padding: "0 12px", fontFamily: "'JetBrains Mono', monospace", outline: "none" };
const sel: React.CSSProperties = { height: 36, borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--bg-2)", color: "var(--ink)", fontSize: 12.5, padding: "0 10px", fontFamily: "'JetBrains Mono', monospace" };
const miniBtn: React.CSSProperties = { height: 32, padding: "0 14px", borderRadius: 8, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", fontSize: 12.5, cursor: "pointer", flexShrink: 0, fontFamily: "'Noto Serif SC', serif" };
