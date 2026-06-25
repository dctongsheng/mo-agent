import React, { useEffect, useState, useCallback } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { useAppState } from "../appState";
import {
  listSpecimens, addSpecimen, strengthenSpecimen, forgetSpecimen, searchMemory, memoryStatus,
  Specimen, MemoryStatus,
} from "../../services/mo-api";

const CAT_COLORS = ["var(--seal)", "var(--indigo)", "var(--moss)"];

// Connection targets are not wired to a backend yet — shown as coming soon.
const SOURCES = [
  { key: "mail", name: "邮箱" },
  { key: "cal", name: "日历" },
  { key: "files", name: "本地文件夹" },
  { key: "browser", name: "浏览器" },
  { key: "im", name: "聊天软件" },
  { key: "notes", name: "笔记应用" },
];

function rotationOf(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `${((Math.abs(h) % 5) - 2) * 0.6}deg`;
}

export function MemoryScreen() {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const { go } = useAppState();
  const [items, setItems] = useState<Specimen[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);

  const refresh = useCallback(() => {
    if (!moPort) return;
    listSpecimens(moPort).then((r) => { setItems(r.data); setLoaded(true); }).catch(() => {});
    memoryStatus(moPort).then(setStatus).catch(() => {});
  }, [moPort]);

  useEffect(() => { refresh(); }, [refresh]);

  const runSearch = () => {
    const q = query.trim();
    if (!moPort) return;
    if (!q) { setSearching(false); refresh(); return; }
    setSearching(true);
    searchMemory(moPort, q).then((r) => { setItems(r.data); setLoaded(true); }).catch(() => {});
  };

  const add = () => {
    const text = draft.trim();
    if (!text || !moPort) return;
    setDraft("");
    addSpecimen(moPort, text).then((r) => setItems((xs) => [r.data, ...xs])).catch(() => {});
  };

  const strengthen = (id: string) => {
    if (!moPort) return;
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, strength: Math.min(3, x.strength + 1) } : x)));
    strengthenSpecimen(moPort, id).catch(() => refresh());
  };

  const forget = (id: string) => {
    if (!moPort) return;
    setItems((xs) => xs.filter((x) => x.id !== id));
    forgetSpecimen(moPort, id).catch(() => refresh());
  };

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "44px 48px 90px" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.22em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>MEMORY · 记忆室</div>
      <h1 style={{ margin: "12px 0 8px", fontFamily: "'Noto Serif SC', serif", fontSize: 28, fontWeight: 650, letterSpacing: "-0.01em" }}>它记得的,都贴在这面墙上。</h1>
      <div style={{ display: "flex", alignItems: "center", gap: 10, maxWidth: 640 }}>
        <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.7, color: "var(--ink-2)" }}>
          每一条记忆都看得见、改得了、忘得掉。
          {status?.backend === "openviking"
            ? "由 OpenViking 语义索引,聊天时小貘会自动取用。"
            : "暂存在本机标本箱(OpenViking 未就绪)。"}
        </p>
        <span style={{
          flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5,
          fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace",
          color: status?.backend === "openviking" ? "var(--moss)" : "var(--moon)",
          border: `1px solid ${status?.backend === "openviking" ? "var(--moss)" : "var(--moon)"}`,
          borderRadius: 99, padding: "2px 9px",
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: "currentColor" }} />
          {status?.backend === "openviking" ? "OpenViking" : "本地"}
        </span>
      </div>

      {/* Data sources — backend connectors not built yet */}
      <div style={{ marginTop: 36 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>数据来源 · CONNECTIONS</div>
          <span style={{ fontSize: 10, color: "var(--moon)", border: "1px dashed var(--moon)", borderRadius: 3, padding: "1px 6px" }}>即将推出</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
          {SOURCES.map((src) => (
            <div key={src.key} style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "13px 16px", boxShadow: "var(--shadow)", opacity: 0.65 }}>
              <span style={{ width: 9, height: 9, borderRadius: 99, background: "var(--line-2)", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{src.name}</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}>未连接</div>
              </div>
              <button
                disabled
                title="连接器开发中"
                style={{ height: 28, padding: "0 12px", borderRadius: 7, border: "1px solid var(--line)", background: "transparent", color: "var(--ink-3)", fontSize: 12, cursor: "default", flexShrink: 0 }}
              >连接</button>
            </div>
          ))}
        </div>
      </div>

      {/* Specimen wall */}
      <div style={{ marginTop: 40 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>记忆标本 · SPECIMENS</div>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{items.length} 条{searching ? " · 搜索结果" : ""}</div>
        </div>

        {/* Semantic search */}
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) runSearch(); }}
            placeholder="搜索记忆…… 按语义找,不只是关键词"
            style={{ flex: 1, height: 38, border: "1px solid var(--line-2)", borderRadius: 9, background: "var(--card)", color: "var(--ink)", fontSize: 13.5, padding: "0 14px", outline: "none" }}
          />
          <button
            onClick={runSearch}
            style={{ height: 38, padding: "0 18px", borderRadius: 9, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", fontSize: 13, cursor: "pointer" }}
          >搜索</button>
          {searching && (
            <button
              onClick={() => { setQuery(""); setSearching(false); refresh(); }}
              style={{ height: 38, padding: "0 14px", borderRadius: 9, border: "none", background: "transparent", color: "var(--ink-3)", fontSize: 13, cursor: "pointer" }}
            >清除</button>
          )}
        </div>

        {/* Add new specimen */}
        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) add(); }}
            placeholder="写一条要它记住的事……"
            style={{ flex: 1, height: 38, border: "1px solid var(--line-2)", borderRadius: 9, background: "var(--card)", color: "var(--ink)", fontSize: 13.5, padding: "0 14px", outline: "none" }}
          />
          <button
            onClick={add}
            style={{ height: 38, padding: "0 18px", borderRadius: 9, border: "none", background: "var(--seal)", color: "oklch(98% 0.01 85)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Serif SC', serif" }}
          >贴上墙</button>
        </div>

        {loaded && items.length === 0 && (
          <div style={{ padding: "36px 0", textAlign: "center", fontSize: 13, color: "var(--ink-3)" }}>
            墙还空着。写一条贴上去,或在工作台聊聊天,它会自己攒。
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20, alignItems: "start" }}>
          {items.map((mem, i) => {
            const catColor = CAT_COLORS[i % CAT_COLORS.length];
            return (
              <div key={mem.id} style={{
                position: "relative", background: "var(--card)", border: "1px solid var(--line)",
                borderRadius: 4, padding: "20px 18px 14px", boxShadow: "var(--shadow)",
                transform: `rotate(${rotationOf(mem.id)})`,
              }}>
                <div style={{ position: "absolute", top: -8, left: "50%", marginLeft: -26, width: 52, height: 15, background: "var(--tape)", transform: "rotate(-1.5deg)" }} />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{
                    fontSize: 10.5, fontWeight: 600, letterSpacing: "0.1em",
                    color: catColor, border: `1.4px solid ${catColor}`,
                    borderRadius: 3, padding: "2px 7px", transform: "rotate(-2deg)", opacity: 0.9,
                  }}>{mem.source}</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[1, 2, 3].map((dot) => (
                      <span key={dot} style={{ width: 7, height: 7, borderRadius: 99, background: "var(--ink)", opacity: mem.strength >= dot ? 0.85 : 0.15 }} />
                    ))}
                  </div>
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.65, minHeight: 66 }}>{mem.text}</div>
                <div style={{ fontSize: 10.5, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", margin: "8px 0 10px" }}>
                  {new Date(mem.created_at * 1000).toLocaleDateString("zh-CN")}
                </div>
                <div style={{ display: "flex", gap: 8, borderTop: "1px dashed var(--line)", paddingTop: 10 }}>
                  <button
                    onClick={() => strengthen(mem.id)}
                    style={{ height: 28, padding: "0 11px", borderRadius: 7, border: "none", background: "var(--moss-soft)", color: "var(--moss)", fontSize: 12, cursor: "pointer" }}
                  >巩固</button>
                  <button
                    onClick={() => forget(mem.id)}
                    style={{ height: 28, padding: "0 11px", borderRadius: 7, border: "none", background: "transparent", color: "var(--ink-3)", fontSize: 12, cursor: "pointer" }}
                  >遗忘</button>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 28, display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontFamily: "'Long Cang', cursive", fontSize: 17, color: "var(--ink-2)" }}>夜里,小貘会在梦中重新整理这面墙——常翻的加深,过期的淡去。</span>
          <button onClick={() => go("dream")} style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", fontSize: 13, color: "var(--indigo)" }}>去看它做梦 →</button>
        </div>
      </div>
    </div>
  );
}
