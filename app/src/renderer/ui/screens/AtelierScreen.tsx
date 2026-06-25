import React, { useEffect, useState, useCallback } from "react";
import { useAppState } from "../appState";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { getModelOptions, getModelInfo, setModel, saveEnvVar, testApiKey } from "../../services/mo-api";

type ProviderOpt = {
  slug: string;
  name: string;
  is_current: boolean;
  is_user_defined: boolean;
  models: string[];
};

// provider slug → env var that holds its API key
function envKeyOf(slug: string): string {
  const base = slug.replace(/^custom:/, "").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `${base}_API_KEY`;
}

/** 工房 section — embedded in the Settings screen. */
export function AtelierSection() {
  const s = useAppState();
  const moPort = useAppSelector((st) => moPortOf(st.gateway.state));
  const [providers, setProviders] = useState<ProviderOpt[]>([]);
  const [current, setCurrent] = useState<{ model: string; provider: string } | null>(null);
  const [selProvider, setSelProvider] = useState<string>("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // API key form state
  const [keyDraft, setKeyDraft] = useState("");
  const [keyStatus, setKeyStatus] = useState<{ kind: "idle" | "testing" | "ok" | "bad" | "saved" | "unknown"; msg: string }>({ kind: "idle", msg: "" });

  const refresh = useCallback(() => {
    if (!moPort) return;
    getModelInfo(moPort).then((mi) => {
      setCurrent({ model: mi.model, provider: mi.provider });
      s.setCurrentModel({ model: mi.model, provider: mi.provider });
      setSelProvider((cur) => cur || mi.provider);
    }).catch(() => {});
    getModelOptions(moPort).then((res: any) => {
      setProviders(res?.providers ?? []);
      setLoaded(true);
    }).catch(() => {});
  }, [moPort]);

  useEffect(() => { refresh(); }, [refresh]);

  const selProv = providers.find((p) => p.slug === selProvider) ?? providers.find((p) => p.is_current) ?? providers[0];

  // clear key form when switching provider
  useEffect(() => { setKeyDraft(""); setKeyStatus({ kind: "idle", msg: "" }); }, [selProv?.slug]);

  const pickModel = (model: string) => {
    if (!moPort || !selProv || switching) return;
    setSwitching(model);
    setModel(moPort, model, selProv.slug)
      .then(() => {
        setCurrent({ model, provider: selProv.slug });
        s.setCurrentModel({ model, provider: selProv.slug });
      })
      .catch(() => {})
      .finally(() => setSwitching(null));
  };

  const doTest = async () => {
    if (!moPort || !selProv || !keyDraft.trim()) return;
    setKeyStatus({ kind: "testing", msg: "" });
    try {
      const providerName = selProv.slug.replace(/^custom:/, "");
      const r = await testApiKey(moPort, providerName, keyDraft.trim());
      if (r.ok && r.reachable) setKeyStatus({ kind: "ok", msg: "钥匙能用 ✓" });
      else if (r.ok && !r.reachable) setKeyStatus({ kind: "unknown", msg: r.message || "无法在线验证,但可以保存。" });
      else setKeyStatus({ kind: "bad", msg: r.message || "钥匙不对。" });
    } catch {
      setKeyStatus({ kind: "bad", msg: "测试请求失败,稍后再试。" });
    }
  };

  const doSave = async () => {
    if (!moPort || !selProv || !keyDraft.trim()) return;
    try {
      await saveEnvVar(moPort, envKeyOf(selProv.slug), keyDraft.trim());
      setKeyStatus({ kind: "saved", msg: "已收进钥匙串 ✓ 重启应用后生效。" });
      setKeyDraft("");
    } catch (e: any) {
      setKeyStatus({ kind: "bad", msg: `保存失败:${e?.message ?? "未知错误"}` });
    }
  };

  const statusColor = { idle: "var(--ink-3)", testing: "var(--ink-3)", ok: "var(--moss)", bad: "var(--seal)", saved: "var(--moss)", unknown: "var(--moon)" }[keyStatus.kind];

  return (
    <div>
      {/* Providers */}
      <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 12 }}>供给方 · PROVIDERS</div>
      {!loaded && <div style={{ fontSize: 13, color: "var(--ink-3)" }}>清点货架中……</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        {providers.map((pv) => (
          <div
            key={pv.slug}
            onClick={() => setSelProvider(pv.slug)}
            style={{ position: "relative", background: "var(--card)", border: `1.5px solid ${pv.slug === selProv?.slug ? "var(--seal)" : "var(--line)"}`, borderRadius: 10, padding: "16px 16px 14px", cursor: "pointer", boxShadow: "var(--shadow)" }}
          >
            <div style={{ fontSize: 14, fontWeight: 650, fontFamily: "'Noto Serif SC', serif", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pv.name}</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>{pv.models.length} 款型号</div>
            {pv.is_current && (
              <span style={{ position: "absolute", top: -9, right: 12, fontSize: 9.5, fontWeight: 600, letterSpacing: "0.08em", color: "var(--seal)", border: "1.4px solid var(--seal)", borderRadius: 3, padding: "1.5px 6px", background: "var(--card)", transform: "rotate(3deg)" }}>服役中</span>
            )}
          </div>
        ))}
      </div>

      {/* API key for selected provider */}
      {selProv && (
        <div style={{ marginTop: 24, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "16px 18px", boxShadow: "var(--shadow)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
            <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>钥匙 · API KEY</span>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{selProv.name} · 写入 {envKeyOf(selProv.slug)}</span>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <input
              value={keyDraft}
              onChange={(e) => { setKeyDraft(e.target.value); setKeyStatus({ kind: "idle", msg: "" }); }}
              placeholder="贴上钥匙 sk-…"
              type="password"
              style={{ flex: 1, height: 40, padding: "0 14px", borderRadius: 9, border: "1px solid var(--line-2)", background: "var(--bg-2)", color: "var(--ink)", fontSize: 13, fontFamily: "'JetBrains Mono', monospace", outline: "none" }}
            />
            <button
              onClick={doTest}
              disabled={!keyDraft.trim() || keyStatus.kind === "testing"}
              style={{ height: 40, padding: "0 18px", borderRadius: 9, border: "1px solid var(--line-2)", background: "transparent", color: keyDraft.trim() ? "var(--ink-2)" : "var(--ink-3)", fontSize: 13, cursor: keyDraft.trim() ? "pointer" : "default" }}
            >{keyStatus.kind === "testing" ? "测试中…" : "测试"}</button>
            <button
              onClick={doSave}
              disabled={!keyDraft.trim()}
              style={{ height: 40, padding: "0 18px", borderRadius: 9, border: "none", background: keyDraft.trim() ? "var(--seal)" : "var(--line)", color: "oklch(98% 0.01 85)", fontSize: 13, fontWeight: 600, cursor: keyDraft.trim() ? "pointer" : "default", fontFamily: "'Noto Serif SC', serif" }}
            >收进钥匙串</button>
          </div>
          {keyStatus.msg && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: statusColor }}>{keyStatus.msg}</div>
          )}
          <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--ink-3)" }}>钥匙只存在本机 ~/.hermes-mo/.env,不上传。</div>
        </div>
      )}

      {/* Model list */}
      {selProv && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
            <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>型号架 · MODELS</span>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{selProv.name} · 点选即切换</span>
          </div>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "var(--shadow)", overflow: "hidden", maxHeight: 320, overflowY: "auto" }}>
            {selProv.models.map((md, i) => {
              const sel = current?.model === md && current?.provider === selProv.slug;
              return (
                <div
                  key={md}
                  onClick={() => pickModel(md)}
                  style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 18px", borderTop: i > 0 ? "1px dashed var(--line)" : "none", cursor: "pointer", opacity: switching && switching !== md ? 0.5 : 1 }}
                >
                  <span style={{ width: 14, height: 14, borderRadius: 99, border: `1.6px solid ${sel ? "var(--seal)" : "var(--line-2)"}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 99, background: sel ? "var(--seal)" : "transparent" }} />
                  </span>
                  <span style={{ flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{md}</span>
                  {switching === md && <span style={{ fontSize: 11, color: "var(--ink-3)" }}>换脑中…</span>}
                  {sel && <span style={{ fontSize: 11, color: "var(--moss)", fontFamily: "'JetBrains Mono', monospace", width: 52, textAlign: "right" }}>服役中</span>}
                </div>
              );
            })}
          </div>
          {current && (
            <div style={{ marginTop: 10, fontFamily: "'Long Cang', cursive", fontSize: 16, color: "var(--ink-2)" }}>
              现在当班的是 {current.model}({current.provider})。
            </div>
          )}
        </div>
      )}

      {/* Profile assignment */}
      {s.profiles.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 12 }}>分身配置 · PROFILES</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {s.profiles.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 14, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "14px 18px", boxShadow: "var(--shadow)" }}>
                <span style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 6, background: "var(--seal-soft)", color: "var(--seal)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Noto Serif SC', serif", fontSize: 14, fontWeight: 700, transform: "rotate(-3deg)" }}>{p.glyph}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>{p.role}</div>
                </div>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "var(--ink-2)" }}>
                  {p.isHost && current ? current.model : p.model}
                </span>
                {p.id === s.currentProfileId && (
                  <span style={{ fontSize: 10.5, color: "var(--moss)", border: "1px solid var(--moss)", borderRadius: 99, padding: "2px 8px", flexShrink: 0 }}>当前</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
