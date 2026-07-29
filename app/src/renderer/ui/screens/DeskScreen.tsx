import React, { useState, useRef, useEffect, useCallback } from "react";
import { useAppState } from "../appState";
import { Doll, getDollMeta } from "../components/Doll";
import { TapeCard } from "../components/TapeCard";
import { Markdown } from "../components/Markdown";
import { streamChat, type ToolEvent } from "../../services/sse-chat";
import { getSessionMessages } from "../../services/gateway-api";
import { recordTrajectory, getModelInfo } from "../../services/mo-api";
import { store } from "../../store/store";

type TraceItem = {
  toolCallId: string;
  emoji: string;
  label: string;
  status: "running" | "completed";
};

type Msg = {
  id: number;
  side: "user" | "agent";
  text: string;
  failed?: boolean;
  retryText?: string;
  specimenNo?: number;
  specimenTurns?: number;
  trace?: TraceItem[];
};

/** Claude-Code-style live tool trace inside an agent bubble. */
function ToolTrace({ items, done }: { items: TraceItem[]; done: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const allDone = done || items.every((t) => t.status === "completed");
  return (
    <div style={{ border: "1px dashed var(--line-2)", borderRadius: 6, padding: "10px 12px", marginBottom: 12 }}>
      <div
        onClick={() => setCollapsed((c) => !c)}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}
      >
        <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>
          实验记录 · TRACE
        </span>
        <span style={{ fontSize: 10, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>
          {items.filter((t) => t.status === "completed").length}/{items.length}
        </span>
        {!allDone && (
          <span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--moon)", animation: "breathe 1.2s ease-in-out infinite" }} />
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-3)" }}>{collapsed ? "▸" : "▾"}</span>
      </div>
      {!collapsed && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {items.map((t, i) => (
            <div key={t.toolCallId} style={{ display: "flex", gap: 10, alignItems: "baseline", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "var(--ink-2)" }}>
              <span style={{ color: "var(--ink-3)", flexShrink: 0 }}>{String(i + 1).padStart(2, "0")}</span>
              <span style={{ flexShrink: 0 }}>{t.emoji}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.label}</span>
              {t.status === "completed"
                ? <span style={{ color: "var(--moss)", flexShrink: 0 }}>✓</span>
                : <span style={{ color: "var(--moon)", flexShrink: 0, animation: "breathe 1.2s ease-in-out infinite" }}>⋯</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SEED_TRACE = [
  { label: "读取日历 · 找到上周 4 场会议", done: true },
  { label: "检索邮件附件 · 取回 3 份纪要", done: true },
  { label: "按你的偏好压缩为要点式周报", done: true },
  { label: "存为草稿,等你过目后发送", done: true },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return "早上好";
  if (h >= 11 && h < 13) return "中午好";
  if (h >= 13 && h < 18) return "下午好";
  if (h >= 18 && h < 23) return "晚上好";
  return "夜深了";
}

function getPorts() {
  const st = store.getState().gateway.state;
  return st.kind === "ready" ? { api: st.port, mo: st.moPort ?? 0 } : { api: 0, mo: 0 };
}

export function DeskScreen({ mainRef }: { mainRef: React.RefObject<HTMLDivElement | null> }) {
  const s = useAppState();
  const [draft, setDraft] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const msgListRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);
  // Set while doSend creates a session for the first message — the session-id
  // effect must not wipe the optimistic messages in that case.
  const creatingRef = useRef(false);

  const { name: dollName, tag: dollTag } = getDollMeta(s.dollForm);

  const today = new Date();
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const dateStr = `${today.getMonth() + 1}月${today.getDate()}日 · 周${weekdays[today.getDay()]}`;

  // Load history from the gateway whenever the selected session changes
  useEffect(() => {
    if (creatingRef.current) {
      // session was just created by doSend — keep the optimistic messages
      sessionRef.current = s.currentSessionId;
      creatingRef.current = false;
      return;
    }
    sessionRef.current = s.currentSessionId;
    setMsgs([]);
    if (!s.currentSessionId) return;
    const { api } = getPorts();
    if (!api) return;
    const sid = s.currentSessionId;
    setLoadingHistory(true);
    getSessionMessages(api, sid)
      .then((data) => {
        if (sessionRef.current !== sid) return; // user switched away meanwhile
        setMsgs(
          data
            .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
            .map((m) => ({
              id: m.id,
              side: m.role === "user" ? "user" as const : "agent" as const,
              text: m.content as string,
            })),
        );
        setTimeout(() => sentinelRef.current?.scrollIntoView(), 50);

        // Backfill: every session written before the rename bug was fixed has
        // title=null on disk and would stay 「未命名的一页」 forever. Its first
        // user message is right here in the response we already fetched, so
        // naming it costs nothing extra. renameCurrentSession no-ops unless the
        // session is still untitled, so this can't overwrite a real name.
        const firstUser = data.find((m) => m.role === "user" && m.content);
        if (firstUser?.content) {
          s.renameCurrentSession(firstUser.content as string, sid);
        }
      })
      .catch(() => { /* gateway warming up — blank page is fine */ })
      .finally(() => { if (sessionRef.current === sid) setLoadingHistory(false); });
  }, [s.currentSessionId]);

  // Auto-scroll only when the user is already near the bottom
  const scrollIfNearBottom = useCallback(() => {
    const el = msgListRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) sentinelRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const isBlank = msgs.length === 0 && !loadingHistory;
  const showSeed = isBlank && s.sessionsLoaded && s.sessions.length === 0;

  const doSend = useCallback(async (text: string) => {
    const { api, mo } = getPorts();
    if (!api) {
      setMsgs((prev) => [...prev, { id: Date.now(), side: "agent", text: "(小貘还没准备好，稍等片刻…)", failed: true, retryText: text }]);
      return;
    }

    // Ensure we have a server session (creates one on first message)
    let sid = sessionRef.current;
    const isFirstMessage = msgs.length === 0;
    if (!sid) {
      creatingRef.current = true;
      sid = await s.newSession();
      if (!sid) creatingRef.current = false;
      if (!sid) {
        setMsgs((prev) => [...prev, { id: Date.now(), side: "agent", text: "(开不出新卷宗，稍等再试)", failed: true, retryText: text }]);
        return;
      }
      sessionRef.current = sid;
    }

    const now = Date.now();
    setMsgs((prev) => [...prev, { id: now, side: "user", text }]);
    setTimeout(() => sentinelRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    // Pass `sid` explicitly: on a brand-new session it was created moments ago
    // and appState's currentSessionId hasn't caught up yet.
    if (isFirstMessage) s.renameCurrentSession(text, sid);

    const replyId = now + 1;
    setBusy(true);
    setMsgs((prev) => [...prev, { id: replyId, side: "agent", text: "" }]);
    const patchReply = (patch: Partial<Msg>) =>
      setMsgs((prev) => prev.map((m) => (m.id === replyId ? { ...m, ...patch } : m)));

    const startedAt = Date.now();
    let acc = "";
    // Session continuity is server-side: send only the new user message.
    streamChat(api, [{ role: "user", content: text }], {
      onDelta: (chunk) => {
        acc += chunk;
        patchReply({ text: acc });
        scrollIfNearBottom();
      },
      onToolEvent: (e: ToolEvent) => {
        setMsgs((prev) => prev.map((m) => {
          if (m.id !== replyId) return m;
          const trace = [...(m.trace ?? [])];
          const idx = trace.findIndex((t) => t.toolCallId === e.toolCallId);
          if (e.status === "running" && idx === -1) {
            trace.push({ toolCallId: e.toolCallId, emoji: e.emoji ?? "⚙", label: e.label ?? e.tool, status: "running" });
          } else if (e.status === "completed" && idx !== -1) {
            trace[idx] = { ...trace[idx], status: "completed" };
          }
          return { ...m, trace };
        }));
        scrollIfNearBottom();
      },
      onDone: (full) => {
        const finalText = full || acc || "(空回复)";
        patchReply({ text: finalText });
        setBusy(false);
        setTimeout(() => sentinelRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
        // Record the trajectory for the self-evolution pipeline (best-effort)
        if (mo) {
          (async () => {
            let model = "unknown";
            try { model = (await getModelInfo(mo)).model; } catch { /* keep unknown */ }
            try {
              const res = await recordTrajectory(mo, {
                prompt: text, reply: finalText, model, duration_ms: Date.now() - startedAt,
                session_id: sid,
              });
              if (res?.count) {
                // One session = one specimen. Move the badge to this latest
                // reply and strip it from earlier replies in the session.
                setMsgs((prev) => prev.map((m) =>
                  m.id === replyId ? { ...m, specimenNo: res.count, specimenTurns: res.turns }
                    : (m.side === "agent" && m.specimenNo != null ? { ...m, specimenNo: undefined } : m)
                ));
              }
            } catch { /* evolution routes unavailable */ }
          })();
        }
      },
      onError: (err) => {
        patchReply({ text: `(连不上小貘:${err.message})`, failed: true, retryText: text });
        setBusy(false);
      },
    }, sid);
  }, [msgs.length, s, scrollIfNearBottom]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    s.noteUserMessage(text);
    setDraft("");

    // Doll easter eggs stay local — instant response, no model round-trip
    let localReply: string | null = null;
    if (/变成.*猫/.test(text)) localReply = "喵——好,换上小猫的样子守着你。";
    else if (/变成.*鸟/.test(text)) localReply = "扑棱。现在是一只小鸟啦。";
    else if (/变回|变成.*貘/.test(text)) localReply = "嗯,还是这副样子最舒服。";
    if (localReply) {
      const now = Date.now();
      setMsgs((prev) => [...prev,
        { id: now, side: "user", text },
        { id: now + 1, side: "agent", text: localReply! },
      ]);
      setTimeout(() => sentinelRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      return;
    }

    void doSend(text);
  };

  const retry = (m: Msg) => {
    if (busy || !m.retryText) return;
    setMsgs((prev) => prev.filter((x) => x.id !== m.id));
    void doSend(m.retryText);
  };

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateColumns: "1fr 296px", gap: 40, padding: "0 48px", alignItems: "start" }}>
      {/* Left: chat — three-layer flex column fills full height */}
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
        {/* Header — fixed */}
        <div style={{ flexShrink: 0, paddingTop: 44 }}>
          <div style={{ fontFamily: "'Long Cang', cursive", fontSize: 19, color: "var(--ink-2)" }}>{dateStr}</div>
          <h1 style={{ margin: "10px 0 0", fontFamily: "'Noto Serif SC', serif", fontSize: 27, fontWeight: 650, letterSpacing: "-0.01em", lineHeight: 1.35 }}>
            {greeting()}。今天想让{dollName}做点什么?
          </h1>
        </div>

        {/* Messages — scrollable, grows to fill */}
        <div ref={msgListRef} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 22, marginTop: 36, paddingBottom: 8 }}>
          {showSeed && (
            <>
              <div style={{ alignSelf: "center", fontSize: 10, letterSpacing: "0.2em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", border: "1px dashed var(--line-2)", borderRadius: 99, padding: "3px 12px" }}>
                示例 · 这是小貘能做的事
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <div style={{ maxWidth: "72%", background: "var(--indigo-soft)", color: "var(--ink)", borderRadius: "12px 12px 3px 12px", padding: "13px 16px", fontSize: 14.5, lineHeight: 1.65 }}>
                  帮我把上周的会议记录整理成一份周报,发到我自己的邮箱。
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{
                  width: 26, height: 26, flexShrink: 0, borderRadius: 6,
                  background: "var(--seal)", color: "oklch(98% 0.01 85)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "'Noto Serif SC', serif", fontSize: 13, transform: "rotate(-4deg)", marginTop: 4,
                }}>貘</div>
                <TapeCard tapeLeft={true} tapeRotate="-3deg" style={{ flex: 1, minWidth: 0, padding: "18px 20px 16px" }}>
                  <div style={{ border: "1px dashed var(--line-2)", borderRadius: 6, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 }}>
                    <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 2 }}>实验记录 · TRACE</div>
                    {SEED_TRACE.map((t, i) => (
                      <div key={i} style={{ display: "flex", gap: 10, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "var(--ink-2)" }}>
                        <span style={{ color: "var(--ink-3)" }}>0{i + 1}</span>
                        <span style={{ flex: 1 }}>{t.label}</span>
                        <span style={{ color: "var(--moss)" }}>✓</span>
                      </div>
                    ))}
                  </div>
                  <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.7, color: "var(--ink)" }}>
                    整理好了。4 场会议浓缩成 6 条要点,草稿已放进你的邮箱——按你的习惯,没超过一页。
                  </p>
                </TapeCard>
              </div>
            </>
          )}

          {isBlank && !showSeed && (
            <div style={{ padding: "52px 0 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <div style={{ fontFamily: "'Long Cang', cursive", fontSize: 21, color: "var(--ink-3)" }}>这一页还是空白。</div>
              <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>在下面写一句,{dollName}就开工。</div>
            </div>
          )}

          {loadingHistory && (
            <div style={{ padding: "40px 0", textAlign: "center", fontSize: 12.5, color: "var(--ink-3)" }}>
              翻开这一页……
            </div>
          )}

          {msgs.map((m) => (
            <div key={m.id} style={{ display: "flex", justifyContent: m.side === "user" ? "flex-end" : "flex-start" }}>
              {m.side === "agent" && (
                <div style={{
                  width: 26, height: 26, flexShrink: 0, borderRadius: 6,
                  background: "var(--seal)", color: "oklch(98% 0.01 85)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "'Noto Serif SC', serif", fontSize: 13, transform: "rotate(-4deg)",
                  marginTop: 4, marginRight: 12,
                }}>貘</div>
              )}
              <div style={{
                // The agent's reply fills the column: its content is prose,
                // lists and code that read badly in a narrow measure, and it's
                // left-aligned so there's nothing for the whitespace to
                // balance against. A user turn stays a bubble — right-aligned
                // text set full-width reads as a wall.
                // minWidth:0 lets a flex child actually wrap long code lines.
                ...(m.side === "agent"
                  ? { flex: 1, minWidth: 0 }
                  : { maxWidth: "72%" }),
                background: m.side === "user" ? "var(--indigo-soft)" : "var(--card)",
                border: m.side === "user" ? "none" : "1px solid var(--line)",
                borderRadius: m.side === "user" ? "12px 12px 3px 12px" : 4,
                padding: "13px 16px", fontSize: 14.5, lineHeight: 1.65,
                boxShadow: m.side === "agent" ? "var(--shadow)" : "none",
              }}>
                {m.side === "agent" && m.trace && m.trace.length > 0 && (
                  <ToolTrace items={m.trace} done={!busy || m.id !== msgs[msgs.length - 1]?.id} />
                )}
                {m.text
                  ? (m.side === "agent" ? <Markdown text={m.text} /> : m.text)
                  : !(m.trace && m.trace.length > 0) && (
                    <span style={{ display: "inline-block", animation: "breathe 1.4s ease-in-out infinite", color: "var(--ink-3)" }}>
                      ……
                    </span>
                  )}
                {m.failed && m.retryText && (
                  <button
                    onClick={() => retry(m)}
                    style={{
                      display: "block", marginTop: 10, padding: "5px 14px", borderRadius: 7,
                      border: "1px solid var(--seal)", background: "transparent",
                      color: "var(--seal)", fontSize: 12.5, cursor: "pointer",
                    }}
                  >重试</button>
                )}
                {m.specimenNo != null && (
                  <button
                    onClick={() => s.goEvolve("overview")}
                    style={{ display: "block", marginTop: 10, border: "none", background: "transparent", padding: 0, cursor: "pointer", fontSize: 12, color: "var(--indigo)" }}
                  >✦ 本次会话已收入训练数据 · 第 {m.specimenNo} 条轨迹{m.specimenTurns && m.specimenTurns > 1 ? ` · ${m.specimenTurns} 轮` : ""} →</button>
                )}
              </div>
            </div>
          ))}
          <div ref={sentinelRef} />
        </div>

        {/* Input — pinned at bottom, never scrolls away */}
        <div style={{ flexShrink: 0, paddingBottom: 32, paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontFamily: "'Long Cang', cursive", fontSize: 15.5, color: "var(--ink-3)" }}>
            小贴士:对它说「变成小猫」试试——玩偶听得懂你的话
          </div>
          <div style={{
            display: "flex", gap: 12, alignItems: "center",
            background: "var(--card)", border: "1px solid var(--line-2)",
            borderRadius: 12, padding: "8px 8px 8px 18px", boxShadow: "var(--shadow)",
          }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // isComposing guards against IME (Chinese pinyin) Enter commits
                if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
              }}
              placeholder={`写给${dollName}的一句话……`}
              style={{ flex: 1, height: 40, border: "none", outline: "none", background: "transparent", color: "var(--ink)", fontSize: 14.5 }}
            />
            <button
              onClick={send}
              disabled={busy}
              style={{
                height: 40, padding: "0 20px", borderRadius: 9, border: "none",
                background: busy ? "var(--line)" : "var(--seal)", color: "oklch(98% 0.01 85)",
                fontSize: 14, fontWeight: 600, cursor: busy ? "default" : "pointer",
                fontFamily: "'Noto Serif SC', serif", transition: "background 0.2s",
              }}
            >{busy ? "…" : "寄出"}</button>
          </div>
        </div>
      </div>

      {/* Right: doll corner — sticky within the grid column */}
      <div style={{ position: "sticky", top: 44, height: "calc(100vh - 88px)", overflowY: "auto", display: "flex", flexDirection: "column", gap: 18, paddingTop: 44, paddingBottom: 32 }}>
        {s.dollOn ? (
          <TapeCard tapeLeft={false} tapeRotate="2.5deg" style={{ padding: "26px 22px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <Doll form={s.dollForm} />
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
              <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650 }}>{dollName}</span>
              <span style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap" }}>{dollTag}</span>
            </div>
            <div style={{ fontFamily: "'Long Cang', cursive", fontSize: 16.5, color: "var(--ink-2)" }}>{s.dollStatus}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={s.cycleDoll} style={btnStyle}>换个形态</button>
              <button onClick={s.petDoll} style={btnStyle}>摸摸头</button>
              <button onClick={s.hideDoll} style={{ ...btnStyle, border: "none", color: "var(--ink-3)" }}>收起</button>
            </div>
          </TapeCard>
        ) : (
          <div style={{ border: "1.5px dashed var(--line-2)", borderRadius: 4, padding: "28px 22px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: "var(--ink-3)" }}>玩偶已收起,它在安静地干活</span>
            <button onClick={s.showDoll} style={{ height: 34, padding: "0 16px", borderRadius: 8, border: "1px solid var(--line-2)", background: "var(--card)", color: "var(--ink-2)", fontSize: 13, cursor: "pointer" }}>唤回小貘</button>
          </div>
        )}

        <TapeCard tapeLeft={true} tapeRotate="-1.5deg" style={{ padding: "18px 20px" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace", marginBottom: 10 }}>今日手记 · JOURNAL</div>
          <div style={{ fontFamily: "'Long Cang', cursive", fontSize: 17, lineHeight: 1.65, color: "var(--ink-2)" }}>
            {msgs.length > 0
              ? `这一页记了 ${msgs.filter((m) => m.side === "user").length} 件事。现在,在等你。`
              : "今天还没翻开新的一页。现在,在等你。"}
          </div>
        </TapeCard>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  height: 32, padding: "0 13px", borderRadius: 8,
  border: "1px solid var(--line-2)", background: "transparent",
  color: "var(--ink-2)", fontSize: 12.5, cursor: "pointer",
};
