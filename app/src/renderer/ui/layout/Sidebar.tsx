import React from "react";
import { useAppState, type Screen } from "../appState";
import { Toggle } from "../components/Toggle";
import { useAppSelector } from "../../store/hooks";

const NAV: Array<{ key: Screen; num: string; label: string; en: string }> = [
  { key: "home",     num: "壹", label: "工作台", en: "DESK" },
  { key: "evolve",   num: "贰", label: "自进化", en: "EVOLVE" },
  { key: "memory",   num: "叁", label: "记忆室", en: "MEMORY" },
  { key: "dream",    num: "肆", label: "梦境",   en: "DREAM" },
  { key: "skills",   num: "伍", label: "技艺",   en: "SKILLS" },
  { key: "settings", num: "陆", label: "设置",   en: "MISC" },
];

const FALLBACK_PROFILE = {
  id: "default", name: "本体 · 小貘", glyph: "貘", form: 0 as const,
  model: "连接中…", role: "", isHost: true, isEvolver: false,
};

export function Sidebar() {
  const s = useAppState();
  const gw = useAppSelector((st) => st.gateway.state);
  const curProf = s.profiles.find((p) => p.id === s.currentProfileId) ?? s.profiles[0] ?? FALLBACK_PROFILE;
  const night = s.screen === "dream" || s.manualNight;
  // The serving model is global config — always show the live value
  const modelOf = (p: { isHost: boolean; model: string }) =>
    p.isHost && s.currentModel ? s.currentModel.model : p.model;

  return (
    <div style={{
      width: 240, flexShrink: 0, display: "flex", flexDirection: "column",
      borderRight: "1px solid var(--line)", background: "var(--bg-2)", height: "100%",
    }}>
      {/* Logo */}
      <div style={{ padding: "22px 20px 18px", display: "flex", alignItems: "center", gap: 12, WebkitAppRegion: "drag" } as React.CSSProperties}>
        <div style={{
          width: 36, height: 36, borderRadius: 7, background: "var(--seal)",
          color: "oklch(98% 0.01 85)", display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "'Noto Serif SC', serif", fontSize: 19, fontWeight: 700,
          transform: "rotate(-4deg)", boxShadow: "var(--shadow)", flexShrink: 0,
        }}>貘</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16.5, fontWeight: 650, letterSpacing: "0.02em" }}>貘 · Mo</span>
          <span style={{ fontSize: 9.5, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>FIELD NOTES AGENT</span>
        </div>
      </div>

      {/* Profile selector */}
      <div style={{ padding: "0 12px 4px" }}>
        <button
          onClick={s.toggleProfileMenu}
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 10,
            padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 10,
            background: "var(--card)", cursor: "pointer", textAlign: "left",
            boxShadow: "var(--shadow)",
          }}
        >
          <span style={{
            width: 28, height: 28, flexShrink: 0, borderRadius: 6,
            background: "var(--seal-soft)", color: "var(--seal)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'Noto Serif SC', serif", fontSize: 14, fontWeight: 700, transform: "rotate(-3deg)",
          }}>{curProf.glyph}</span>
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{curProf.name}</span>
            <span style={{ fontSize: 9.5, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{modelOf(curProf)}</span>
          </span>
          <span style={{ color: "var(--ink-3)", fontSize: 10, flexShrink: 0 }}>{s.profileMenuOpen ? "▴" : "▾"}</span>
        </button>

        {s.profileMenuOpen && (
          <div style={{
            marginTop: 6, border: "1px solid var(--line)", borderRadius: 10,
            background: "var(--card)", boxShadow: "var(--shadow)", padding: 6,
            display: "flex", flexDirection: "column", gap: 2,
          }}>
            {s.profiles.map((p) => (
              <div
                key={p.id}
                onClick={() => s.selectProfile(p.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "7px 8px",
                  borderRadius: 7, background: p.id === s.currentProfileId ? "var(--bg-2)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <span style={{
                  width: 22, height: 22, flexShrink: 0, borderRadius: 5,
                  border: "1.4px solid var(--seal)", color: "var(--seal)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "'Noto Serif SC', serif", fontSize: 11, fontWeight: 700,
                  transform: "rotate(-3deg)", opacity: 0.85,
                }}>{p.glyph}</span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 12.5, fontWeight: p.id === s.currentProfileId ? 600 : 500, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                  <span style={{ fontSize: 9.5, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{modelOf(p)}</span>
                </span>
                {!p.isHost && !p.isEvolver && (
                  <button
                    onClick={(e) => { e.stopPropagation(); s.deleteProfile(p.id); }}
                    style={{ width: 18, height: 18, flexShrink: 0, border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}
                  >×</button>
                )}
                {p.isEvolver && (
                  <span title="常驻进化分身" style={{ flexShrink: 0, fontSize: 11, color: "var(--moon)" }}>🌙</span>
                )}
              </div>
            ))}
            <div style={{ display: "flex", gap: 6, borderTop: "1px dashed var(--line)", marginTop: 4, paddingTop: 6 }}>
              <button onClick={s.createProfile} style={{ flex: 1, height: 30, borderRadius: 7, border: "1px dashed var(--line-2)", background: "transparent", color: "var(--ink-2)", fontSize: 12, cursor: "pointer" }}>＋ 新建分身</button>
              <button onClick={s.cloneProfile} style={{ flex: 1, height: 30, borderRadius: 7, border: "1px dashed var(--line-2)", background: "transparent", color: "var(--ink-2)", fontSize: 12, cursor: "pointer" }}>克隆当前</button>
            </div>
          </div>
        )}
      </div>

      {/* Nav items */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "8px 12px" }}>
        {NAV.map((n) => {
          const active = s.screen === n.key;
          return (
            <button
              key={n.key}
              onClick={() => s.go(n.key)}
              style={{
                display: "flex", alignItems: "center", gap: 12, height: 38,
                padding: "0 14px", border: `1px solid ${active ? "var(--line)" : "transparent"}`,
                borderRadius: 9, background: active ? "var(--card)" : "transparent",
                color: active ? "var(--ink)" : "var(--ink-2)", cursor: "pointer", fontSize: 14, textAlign: "left",
              }}
            >
              <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 14, color: active ? "var(--seal)" : "var(--ink-3)", width: 16 }}>{n.num}</span>
              <span style={{ flex: 1, fontWeight: active ? 600 : 500 }}>{n.label}</span>
              <span style={{ fontSize: 9, letterSpacing: "0.12em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>{n.en}</span>
            </button>
          );
        })}
      </div>

      {/* Sessions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "12px 12px 4px", flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px 8px" }}>
          <span style={{ fontSize: 9.5, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>卷宗 · SESSIONS</span>
          <button
            onClick={s.newSession}
            style={{ width: 22, height: 22, borderRadius: 6, border: "1px dashed var(--line-2)", background: "transparent", color: "var(--ink-2)", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}
          >＋</button>
        </div>
        {!s.sessionsLoaded && (
          <div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--ink-3)" }}>翻找卷宗中…</div>
        )}
        {s.sessionsLoaded && s.sessions.length === 0 && (
          <div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--ink-3)" }}>还没有卷宗,点 ＋ 开一页</div>
        )}
        {s.sessions.map((sess) => {
          const active = sess.id === s.currentSessionId;
          return (
            <div
              key={sess.id}
              onClick={() => s.selectSession(sess.id)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                borderRadius: 8, background: active ? "var(--card)" : "transparent", cursor: "pointer",
              }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: active ? 600 : 400, color: active ? "var(--ink)" : "var(--ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sess.title}</span>
              <span style={{ fontSize: 9, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>{sess.time}</span>
              <button
                onClick={(e) => { e.stopPropagation(); s.deleteSession(sess.id); }}
                style={{ width: 16, height: 16, flexShrink: 0, border: "none", background: "transparent", color: "var(--ink-3)", opacity: 0.45, cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}
              >×</button>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ padding: "12px 18px 14px", display: "flex", flexDirection: "column", gap: 10, borderTop: "1px dashed var(--line)" }}>
        <button
          onClick={s.toggleNight}
          style={{
            display: "flex", alignItems: "center", gap: 10, height: 38, padding: "0 12px",
            border: "1px solid var(--line)", borderRadius: 9, background: "transparent",
            color: "var(--ink-2)", cursor: "pointer", fontSize: 13,
          }}
        >
          <span style={{ width: 9, height: 9, borderRadius: 99, background: night ? "var(--moon)" : "var(--line-2)", flexShrink: 0 }} />
          {s.screen === "dream" ? "梦境时分 · 自动入夜" : (s.manualNight ? "夜灯 · 开" : "夜灯 · 关")}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>
          <span style={{
            width: 7, height: 7, borderRadius: 99, flexShrink: 0,
            background: gw?.kind === "ready" ? "var(--moss)" : gw?.kind === "failed" ? "var(--seal)" : "var(--moon)",
          }} />
          {gw?.kind === "ready" ? `已连接 · :${gw.port}` : gw?.kind === "failed" ? "后端启动失败" : "后端启动中…"}
          <span style={{ marginLeft: "auto" }}>v0.1</span>
        </div>
      </div>
    </div>
  );
}
