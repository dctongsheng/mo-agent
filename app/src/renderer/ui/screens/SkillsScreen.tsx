import React, { useEffect, useState, useCallback } from "react";
import { useAppState } from "../appState";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { TapeCard } from "../components/TapeCard";
import { Toggle } from "../components/Toggle";
import { listSkills, toggleSkill as apiToggleSkill, hubSearch, Skill } from "../../services/mo-api";

const CAT_COLORS = ["var(--seal)", "var(--indigo)", "var(--moss)", "var(--moon)"];

function catColor(category: string): string {
  let h = 0;
  for (const c of category) h = (h * 31 + c.charCodeAt(0)) | 0;
  return CAT_COLORS[Math.abs(h) % CAT_COLORS.length];
}

export function SkillsScreen() {
  const { goEvolve } = useAppState();
  const moPort = useAppSelector((st) => moPortOf(st.gateway.state));
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hubOpen, setHubOpen] = useState(false);
  const [hubItems, setHubItems] = useState<any[]>([]);
  const [hubLoading, setHubLoading] = useState(false);

  const refresh = useCallback(() => {
    if (!moPort) return;
    listSkills(moPort).then((sk) => { setSkills(sk); setLoaded(true); }).catch(() => {});
  }, [moPort]);

  useEffect(() => { refresh(); }, [refresh]);

  const onToggle = (sk: Skill) => {
    if (!moPort) return;
    setSkills((ss) => ss.map((x) => (x.name === sk.name ? { ...x, enabled: !x.enabled } : x)));
    apiToggleSkill(moPort, sk.name, !sk.enabled).catch(() => refresh());
  };

  const openHub = () => {
    if (!moPort) return;
    setHubOpen(true);
    setHubLoading(true);
    hubSearch(moPort, "")
      .then((res) => setHubItems(Array.isArray(res) ? res : res?.results ?? res?.data ?? []))
      .catch(() => setHubItems([]))
      .finally(() => setHubLoading(false));
  };

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "44px 48px 90px" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.22em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>SKILLS · 技艺</div>
      <h1 style={{ margin: "12px 0 8px", fontFamily: "'Noto Serif SC', serif", fontSize: 28, fontWeight: 650, letterSpacing: "-0.01em" }}>会的事,都写成了方子。</h1>
      <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.7, color: "var(--ink-2)", maxWidth: 620 }}>
        技艺是一张张可启停的方子卡。关掉即收进抽屉,不占脑子。这里列出的是 Hermes 实际装着的技能。
      </p>

      {!loaded && (
        <div style={{ marginTop: 48, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>翻方子中……</div>
      )}
      {loaded && skills.length === 0 && (
        <div style={{ marginTop: 48, textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>抽屉空空,去技艺坊淘几张方子吧。</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 36 }}>
        {skills.map((sk, i) => {
          const srcColor = catColor(sk.category ?? "misc");
          return (
            <TapeCard
              key={sk.name}
              tapeLeft={true}
              tapeRotate={i % 2 ? "-2.5deg" : "2deg"}
              style={{ padding: "20px 22px 16px", opacity: sk.enabled ? 1 : 0.55 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16.5, fontWeight: 650 }}>{sk.name}</span>
                <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", color: srcColor, border: `1.4px solid ${srcColor}`, borderRadius: 3, padding: "1.5px 6px", transform: "rotate(-2deg)", opacity: 0.9 }}>{sk.category}</span>
                <span style={{ flex: 1 }} />
                <Toggle on={sk.enabled} onChange={() => onToggle(sk)} />
              </div>
              <div style={{ fontSize: 13.5, lineHeight: 1.65, color: "var(--ink-2)", minHeight: 44 }}>{sk.description}</div>
              <div style={{ display: "flex", gap: 12, marginTop: 10, borderTop: "1px dashed var(--line)", paddingTop: 10, fontSize: 10.5, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>
                <span>{sk.category}</span>
                <span style={{ flex: 1 }} />
                <span>{sk.enabled ? "启用中" : "已收起"}</span>
              </div>
            </TapeCard>
          );
        })}
      </div>

      <div style={{ marginTop: 32, background: "var(--card)", border: "1px dashed var(--line-2)", borderRadius: 10, padding: "18px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 15, fontWeight: 650 }}>技艺坊 · SKILL HUB</div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 3 }}>去坊里淘新方子,或把自学的方子分享给别人。</div>
          </div>
          <button
            onClick={hubOpen ? () => setHubOpen(false) : openHub}
            style={{ height: 38, padding: "0 18px", borderRadius: 9, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", fontSize: 13, cursor: "pointer" }}
          >{hubOpen ? "收起" : "去逛逛 →"}</button>
        </div>
        {hubOpen && (
          <div style={{ marginTop: 14, borderTop: "1px dashed var(--line)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {hubLoading && <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>赶集中……</div>}
            {!hubLoading && hubItems.length === 0 && <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>坊里暂时没货,过几天再来。</div>}
            {hubItems.slice(0, 8).map((it: any, i: number) => (
              <div key={i} style={{ display: "flex", gap: 10, fontSize: 12.5, color: "var(--ink-2)" }}>
                <span style={{ fontWeight: 600, color: "var(--ink)" }}>{it.name ?? it.id ?? "?"}</span>
                <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.description ?? ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ marginTop: 18, display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontFamily: "'Long Cang', cursive", fontSize: 17, color: "var(--ink-2)" }}>它做过的每件事都会留下轨迹,攒多了就能在梦里学成新方子。</span>
        <button onClick={() => goEvolve("skills")} style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", fontSize: 13, color: "var(--indigo)" }}>去看它怎么学的 →</button>
      </div>
    </div>
  );
}
