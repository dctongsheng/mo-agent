import React from "react";
import { useAppState } from "../appState";
import { Toggle } from "../components/Toggle";
import { TapeCard } from "../components/TapeCard";
import { AtelierSection } from "./AtelierScreen";
import { FinetuneSettings } from "./FinetuneSettings";
import { ModelConfigSettings } from "./ModelConfigSettings";

const MSGR_DEFS = [
  { k: "tg", name: "Telegram" },
  { k: "wa", name: "WhatsApp" },
  { k: "dc", name: "Discord" },
  { k: "fs", name: "飞书" },
];

const MCP_DEFS = [
  { k: "fs", glyph: "文", name: "文件系统", sub: "mcp-filesystem", c: "var(--indigo)" },
  { k: "browser", glyph: "览", name: "浏览器", sub: "mcp-playwright", c: "var(--moss)" },
  { k: "gh", glyph: "码", name: "GitHub", sub: "mcp-github", c: "var(--ink-2)" },
  { k: "cal", glyph: "历", name: "日历", sub: "mcp-calendar", c: "var(--seal)" },
];

function ComingSoon() {
  return (
    <span style={{ fontSize: 10, color: "var(--moon)", border: "1px dashed var(--moon)", borderRadius: 3, padding: "1px 6px", flexShrink: 0 }}>即将推出</span>
  );
}

export function SettingsScreen() {
  const s = useAppState();

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "44px 48px 90px" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.22em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>SETTINGS · 设置</div>
      <h1 style={{ margin: "12px 0 8px", fontFamily: "'Noto Serif SC', serif", fontSize: 28, fontWeight: 650, letterSpacing: "-0.01em" }}>抽屉里的零碎事。</h1>
      <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.7, color: "var(--ink-2)", maxWidth: 620 }}>
        模型与钥匙、信使、MCP、本地模型、语音,和这个软件本身。带「即将推出」标记的还在打磨。
      </p>

      {/* 工房 — models & API keys */}
      <div style={{ marginTop: 36 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>工房 · ATELIER</span>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>给每只分身配一颗合适的脑子</span>
        </div>
        <AtelierSection />
      </div>

      {/* 模型配置 — un-hardcode embedding / evolve / mint */}
      <ModelConfigSettings />

      {/* Messengers — backend wiring not built yet */}
      <div style={{ marginTop: 36 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>信使 · MESSENGERS</span>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>接上聊天软件,人不在电脑前也能差遣它</span>
          <ComingSoon />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {MSGR_DEFS.map((d) => (
            <div key={d.k} style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "13px 16px", boxShadow: "var(--shadow)", opacity: 0.65 }}>
              <span style={{ width: 9, height: 9, borderRadius: 99, background: "var(--line-2)", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{d.name}</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}>未接通</div>
              </div>
              <button disabled title="信使接入开发中" style={{ height: 28, padding: "0 12px", borderRadius: 7, border: "1px solid var(--line)", background: "transparent", color: "var(--ink-3)", fontSize: 12, cursor: "default", flexShrink: 0 }}>接通</button>
            </div>
          ))}
        </div>
      </div>

      {/* MCP — display only for now */}
      <div style={{ marginTop: 40 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>MCP 印盒 · SERVERS</span>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>每方印,给它一类新本事</span>
          <ComingSoon />
        </div>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "var(--shadow)", overflow: "hidden" }}>
          {MCP_DEFS.map((d, i) => {
            const on = s.mcpOn[d.k];
            return (
              <div key={d.k} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 18px", borderTop: i > 0 ? "1px dashed var(--line)" : "none", opacity: on ? 1 : 0.55 }}>
                <span style={{ width: 26, height: 26, flexShrink: 0, border: `1.6px solid ${d.c}`, color: d.c, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Noto Serif SC', serif", fontSize: 12, fontWeight: 600, transform: i % 2 ? "rotate(4deg)" : "rotate(-4deg)", opacity: 0.9 }}>{d.glyph}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{d.name}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2, fontFamily: "'JetBrains Mono', monospace" }}>{d.sub}</div>
                </div>
                <Toggle on={on} onChange={() => s.toggleMcp(d.k)} />
              </div>
            );
          })}
          <div style={{ padding: "12px 18px", borderTop: "1px dashed var(--line)" }}>
            <button disabled title="MCP 管理开发中" style={{ height: 32, padding: "0 14px", borderRadius: 8, border: "1px dashed var(--line)", background: "transparent", color: "var(--ink-3)", fontSize: 12.5, cursor: "default" }}>＋ 刻一方新印 · 添加 MCP 服务</button>
          </div>
        </div>
      </div>

      {/* 本地灶台 (Ollama) + 微调数据集 */}
      <FinetuneSettings />

      {/* Voice + Misc */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 40 }}>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>语音 · VOICE</span>
            <ComingSoon />
          </div>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "4px 18px", boxShadow: "var(--shadow)", opacity: 0.65 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 0", borderBottom: "1px dashed var(--line)" }}>
              <span style={{ fontSize: 13.5 }}>用说的,不用打字</span>
              <Toggle on={s.voiceOn} onChange={s.toggleVoice} />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 0" }}>
              <span style={{ fontSize: 13.5 }}>唤醒词</span>
              <span style={{ fontFamily: "'Long Cang', cursive", fontSize: 17, color: "var(--ink-2)" }}>「小貘小貘」</span>
            </div>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 12 }}>杂项 · MISC</div>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "4px 18px", boxShadow: "var(--shadow)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 0", borderBottom: "1px dashed var(--line)" }}>
              <span style={{ fontSize: 13.5 }}>开机时跟着醒来</span>
              <Toggle on={s.autostart} onChange={s.toggleAutostart} />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 0" }}>
              <span style={{ fontSize: 13.5 }}>新分身默认带玩偶</span>
              <Toggle on={s.dollDefault} onChange={s.toggleDollDefault} />
            </div>
          </div>
        </div>
      </div>

      {/* About */}
      <div style={{ marginTop: 40 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 12 }}>关于 · ABOUT</div>
        <TapeCard tapeLeft={true} tapeRotate="-2deg" style={{ padding: "20px 22px", display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 44, height: 44, borderRadius: 9, background: "var(--seal)", color: "oklch(98% 0.01 85)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Noto Serif SC', serif", fontSize: 23, fontWeight: 700, transform: "rotate(-4deg)", flexShrink: 0 }}>貘</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650 }}>貘 · Mo</div>
            <div style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", marginTop: 3 }}>v0.1.0 · hermes core · macOS arm64</div>
          </div>
        </TapeCard>
      </div>
    </div>
  );
}
