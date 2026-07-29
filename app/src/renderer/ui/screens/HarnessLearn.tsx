import React, { useCallback, useEffect, useState } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { TapeCard } from "../components/TapeCard";
import { PendingRestart } from "../components/PendingRestart";
import {
  getLearnStatus, startLearn, listLearnDrafts, getLearnDraft,
  acceptLearnDraft, rejectLearnDraft, getLearnLog,
  LearnStatus, LearnDraft,
} from "../../services/mo-api";

function fmt(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const STATUS_LABEL: Record<string, string> = {
  running: "学习中…", done: "待审", failed: "失败", accepted: "已收下", rejected: "已弃用",
};
const STATUS_COLOR: Record<string, string> = {
  running: "var(--moon)", done: "var(--indigo)", failed: "var(--seal)",
  accepted: "var(--moss)", rejected: "var(--ink-3)",
};

const MAX_DESC = 60;

/** LEARN · 教它一手 — Hermes' /learn, sandboxed and reviewed before it lands. */
export function HarnessLearn() {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const [status, setStatus] = useState<LearnStatus | null>(null);
  const [drafts, setDrafts] = useState<LearnDraft[]>([]);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<LearnDraft | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logText, setLogText] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!moPort) return;
    getLearnStatus(moPort).then(setStatus).catch(() => {});
    listLearnDrafts(moPort).then((r) => setDrafts(r.data)).catch(() => {});
  }, [moPort]);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll while a turn is in flight — a learn run does real tool work and can
  // take minutes.
  useEffect(() => {
    if (!moPort || !drafts.some((d) => d.status === "running")) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [moPort, drafts, refresh]);

  const start = () => {
    if (!moPort || !request.trim() || busy) return;
    setBusy(true);
    startLearn(moPort, request.trim()).then((r) => {
      if (!r.ok) { setNotice(`学不了：${r.reason ?? "未知原因"}`); return; }
      setRequest("");
      setTimeout(refresh, 500);
    }).catch(() => {}).finally(() => setBusy(false));
  };

  const view = (id: string) => {
    if (!moPort) return;
    setRefusal(null); setLogText(null);
    getLearnDraft(moPort, id).then(setOpen).catch(() => {});
  };

  const accept = (force = false) => {
    if (!moPort || !open) return;
    acceptLearnDraft(moPort, open.id, { force }).then((r) => {
      if (r.ok) {
        setOpen(null); setRefusal(null); refresh();
        setNotice(`已收下 · 存为 v${String(r.archive_version).padStart(4, "0")} · 下次启动生效`);
      } else {
        setRefusal(r.message);
        // A frontmatter problem is the one refusal force cannot clear, so
        // don't offer a force button that would just fail again.
        if (r.error === "invalid_frontmatter") setRefusal(r.message + "（这一条强制也没用）");
      }
    }).catch(() => {});
  };

  const desc = open?.skill?.description ?? "";
  const descOver = desc.length > MAX_DESC;
  const hardBlocked = (open?.validation ?? []).some((v) => v.fatal && v.code !== "name_taken");

  const btn: React.CSSProperties = { height: 34, padding: "0 14px", borderRadius: 8, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", fontSize: 12.5, cursor: "pointer" };

  return (
    <div style={{ marginTop: 48 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 11, letterSpacing: "0.2em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>LEARN · 教它一手</span>
        {status && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace", color: status.ready ? "var(--moss)" : "var(--moon)", border: `1px solid ${status.ready ? "var(--moss)" : "var(--moon)"}`, borderRadius: 99, padding: "2px 9px" }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, background: "currentColor" }} />
            {status.ready ? "可以学" : `未就绪 · ${status.reason}`}
          </span>
        )}
      </div>
      <h2 style={{ margin: "8px 0 6px", fontFamily: "'Noto Serif SC', serif", fontSize: 21, fontWeight: 650 }}>
        把刚做过的事,记成一条方子。
      </h2>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: "var(--ink-2)", maxWidth: 660 }}>
        给它一个目录、一个网址,或者就说「把刚才那套流程记下来」。它会在沙箱里写一份 SKILL.md,
        你看过再决定收不收 —— 在你点头之前,真正的技艺目录一个字都不会动。
      </p>

      <PendingRestart port={moPort} pending={status?.pending} />

      {/* If the vendored authoring standards couldn't be imported, the draft
          was written without the house rules. Say that rather than implying
          they were applied. */}
      {status?.standards === "unavailable" && (
        <div style={{ marginTop: 14, padding: "9px 14px", borderRadius: 9, fontSize: 12.5,
                      border: "1px solid var(--moon)", color: "var(--moon)", lineHeight: 1.6 }}>
          ⚠ 读不到 Hermes 的撰写规范,这次用的是简化提示 —— 格式可能不合规矩。
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26, marginTop: 26, alignItems: "start" }}>
        <TapeCard tapeLeft={true} tapeRotate="2deg" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650, marginBottom: 12 }}>学点什么</div>
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder={"把刚才折腾 arxiv 那套流程记下来\n或：~/code/my-tool 这个目录，学一下怎么用\n或：https://… 这篇文档"}
            rows={5}
            style={{ width: "100%", boxSizing: "border-box", borderRadius: 8, border: "1px solid var(--line-2)",
                     background: "transparent", color: "var(--ink-1)", padding: "10px 12px",
                     fontSize: 13, lineHeight: 1.7, resize: "vertical", fontFamily: "inherit" }}
          />
          <button onClick={start} disabled={busy || !request.trim() || !status?.ready} style={{
            width: "100%", height: 40, marginTop: 12, borderRadius: 9, border: "none",
            background: (busy || !request.trim() || !status?.ready) ? "var(--line)" : "var(--seal)",
            color: "oklch(98% 0.01 85)", fontSize: 14, fontWeight: 600,
            cursor: (busy || !request.trim() || !status?.ready) ? "default" : "pointer",
            fontFamily: "'Noto Serif SC', serif",
          }}>{busy ? "启动中…" : "学一下 →"}</button>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 10, lineHeight: 1.7 }}>
            在沙箱 profile 里跑一次完整的对话,最多 {status?.timeout ?? 600} 秒。
            它会自己读资料、写文件。
          </div>
          {notice && <div style={{ fontSize: 11.5, color: "var(--moss)", marginTop: 8 }}>{notice}</div>}
        </TapeCard>

        <TapeCard tapeLeft={false} tapeRotate="-2deg" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650, marginBottom: 12 }}>草稿</div>
          {drafts.length === 0 && <div style={{ fontSize: 13, color: "var(--ink-3)" }}>还没教过它什么。</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 340, overflowY: "auto" }}>
            {drafts.map((d) => (
              <div key={d.id} onClick={() => d.status !== "running" && view(d.id)} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                border: "1px solid var(--line)", borderRadius: 8, background: "var(--card)",
                cursor: d.status === "running" ? "default" : "pointer",
              }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_COLOR[d.status], flexShrink: 0, ...(d.status === "running" ? { animation: "breathe 1.4s ease-in-out infinite" } : {}) }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {d.skill_name || d.request.slice(0, 40)}
                  </span>
                  {d.description && (
                    <span style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5 }}>{d.description}</span>
                  )}
                  {d.error && <span style={{ fontSize: 11, color: "var(--seal)" }}>{d.error}</span>}
                </span>
                <span style={{ fontSize: 11, color: STATUS_COLOR[d.status], flexShrink: 0 }}>{STATUS_LABEL[d.status]}</span>
                <span style={{ fontSize: 11, color: "var(--ink-3)", flexShrink: 0 }}>{fmt(d.created_at)}</span>
              </div>
            ))}
          </div>
        </TapeCard>
      </div>

      {/* ---- draft modal ---- */}
      {open && (
        <div onClick={() => setOpen(null)} style={{
          position: "fixed", inset: 0, background: "oklch(20% 0.02 60 / 0.45)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 40,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "var(--card)", borderRadius: 12, boxShadow: "var(--shadow)",
            width: "min(860px, 92vw)", maxHeight: "86vh", display: "flex", flexDirection: "column",
            border: "1px solid var(--line)",
          }}>
            <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, fontWeight: 650 }}>
                {open.skill?.name || "（没有产出）"}
              </span>
              {open.skill?.category && <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{open.skill.category}</span>}
              <span style={{ marginLeft: "auto", cursor: "pointer", color: "var(--ink-3)", fontSize: 18 }} onClick={() => setOpen(null)}>×</span>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px" }}>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 12, lineHeight: 1.6 }}>
                你说的是：{open.request}
              </div>

              {/* The description counter. This rule is violated constantly and
                  fails silently — over 60 chars the system-prompt index
                  truncates it and the skill never routes, while still looking
                  perfectly installed. */}
              {open.skill && (
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 9,
                              border: `1px solid ${descOver ? "var(--seal)" : "var(--line-2)"}`, fontSize: 12.5, lineHeight: 1.7 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>description</span>
                    <span style={{ marginLeft: "auto", fontFamily: "'JetBrains Mono', monospace",
                                   color: descOver ? "var(--seal)" : "var(--ink-3)" }}>
                      {desc.length}/{MAX_DESC}
                    </span>
                  </div>
                  <div style={{ color: "var(--ink-2)", marginTop: 3 }}>{desc || "（空）"}</div>
                  {descOver && (
                    <div style={{ color: "var(--seal)", marginTop: 4 }}>
                      超出的部分会被系统提示索引悄悄截掉 —— 技艺装上了、列表里看得见,却永远不会被用到。
                      让它重写一遍。
                    </div>
                  )}
                </div>
              )}

              {open.staged && (
                <div style={{ marginBottom: 12, fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.6 }}>
                  这份草稿是从暂存队列里取出来的（沙箱开了写入审批），内容完整。
                </div>
              )}

              {open.collides_with && (
                <div style={{ marginBottom: 12, padding: "9px 14px", borderRadius: 9, fontSize: 12.5,
                              border: "1px solid var(--moon)", color: "var(--moon)", lineHeight: 1.6 }}>
                  已经有一条叫「{open.collides_with}」的技艺 —— 收下会覆盖它（旧的会先存档，可回退）。
                </div>
              )}

              {!!open.findings?.length && (
                <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 9, fontSize: 12.5,
                              border: "1px solid var(--moon)", lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 600, color: "var(--moon)" }}>新写的内容里有 {open.findings.length} 处需要过目</div>
                  {open.findings.slice(0, 5).map((f, i) => (
                    <div key={i} style={{ marginTop: 3, color: f.severity === "high" ? "var(--seal)" : "var(--ink-2)" }}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                        [{f.severity === "high" ? "高危" : "留意"} · {f.pattern}]
                      </span>{" "}{f.why}
                    </div>
                  ))}
                </div>
              )}

              {open.skill?.files?.length ? (
                <div style={{ marginBottom: 12, fontSize: 11.5, color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>
                  附带文件：{open.skill.files.map((f) => f.path).join("、")}
                </div>
              ) : null}

              {logText !== null ? (
                <pre style={{ margin: 0, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "var(--ink-2)" }}>{logText}</pre>
              ) : open.skill?.content ? (
                <pre style={{ margin: 0, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--ink-2)" }}>
                  {open.skill.content}
                </pre>
              ) : (
                <div style={{ fontSize: 13, color: "var(--ink-3)" }}>这次没有写出技艺，看看日志。</div>
              )}
            </div>

            <div style={{ padding: "14px 22px", borderTop: "1px solid var(--line)", display: "flex", gap: 12, alignItems: "center" }}>
              <button onClick={() => moPort && getLearnLog(moPort, open.id).then((r) => setLogText(r.data || "(日志为空)"))} style={btn}>
                查看日志
              </button>
              {refusal && <span style={{ fontSize: 12, color: "var(--seal)", maxWidth: 360, lineHeight: 1.5 }}>{refusal}</span>}
              {open.status === "done" && (
                <div style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
                  <button onClick={() => moPort && rejectLearnDraft(moPort, open.id).then(() => { setOpen(null); refresh(); })} style={btn}>弃用</button>
                  {hardBlocked ? (
                    // No force button: the frontmatter refusal is the one Mo
                    // will not override, because forcing it installs a skill
                    // that cannot fire.
                    <button disabled style={{ ...btn, opacity: 0.5, cursor: "default" }}>需要重写才能收下</button>
                  ) : refusal ? (
                    <button onClick={() => accept(true)} style={{ ...btn, height: 38, borderColor: "var(--seal)", color: "var(--seal)", fontWeight: 600 }}>仍要收下</button>
                  ) : (
                    <button onClick={() => accept(false)} style={{ height: 38, padding: "0 20px", borderRadius: 9, border: "none", background: "var(--seal)", color: "oklch(98% 0.01 85)", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Serif SC', serif" }}>收下 · 写进技艺</button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
