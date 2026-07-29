import React, { useCallback, useEffect, useState } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { useAppState } from "../appState";
import { TapeCard } from "../components/TapeCard";
import {
  listPending, getPendingDetail, approvePending, rejectPending,
  setPendingPolicy, getReviewLog, setReviewIntervals,
  PendingList, PendingItem, ReviewLogEntry,
} from "../../services/mo-api";

function fmt(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const KIND_LABEL: Record<string, string> = {
  "skills-write": "写技艺", "memory-write": "记一笔",
  retirement: "想收起", "learn-draft": "学了一手",
};
const ORIGIN_LABEL: Record<string, string> = {
  background_review: "它自己想的", foreground: "你让它做的", curator: "清点时发现的",
};

/** 待办 — everything the agent wants to change about itself, waiting on you. */
export function HarnessInbox() {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const s = useAppState();
  const [list, setList] = useState<PendingList | null>(null);
  const [log, setLog] = useState<ReviewLogEntry[]>([]);
  const [open, setOpen] = useState<any | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const refresh = useCallback(() => {
    if (!moPort) return;
    listPending(moPort).then(setList).catch(() => {});
    getReviewLog(moPort).then((r) => setLog(r.data)).catch(() => {});
  }, [moPort]);

  useEffect(() => { refresh(); }, [refresh]);

  const act = (p: Promise<any>, ok: (r: any) => string) => {
    setBusy(true);
    p.then((r) => setNotice(ok(r))).catch(() => setNotice("操作失败"))
      .finally(() => { setBusy(false); setOpen(null); refresh(); });
  };

  const view = (it: PendingItem) => {
    if (!moPort) return;
    if (it.kind === "retirement") { s.go("evolve"); return; }
    if (it.kind === "learn-draft") { s.go("evolve"); return; }
    getPendingDetail(moPort, it.subsystem!, it.id)
      .then((d) => setOpen({ ...d, _item: it })).catch(() => {});
  };

  const items = list?.data ?? [];
  const bg = list?.counts?.background ?? 0;
  const rv = list?.review;

  const btn: React.CSSProperties = { border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", borderRadius: 6, fontSize: 11.5, padding: "3px 10px", cursor: "pointer" };
  const numIn: React.CSSProperties = { width: 54, height: 26, borderRadius: 6, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-1)", padding: "0 6px", fontSize: 12 };

  return (
    <div style={{ marginTop: 48 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>
        PENDING · 待办
      </div>
      <h2 style={{ margin: "8px 0 6px", fontFamily: "'Noto Serif SC', serif", fontSize: 21, fontWeight: 650 }}>
        它想改自己的地方,都在这儿等你点头。
      </h2>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: "var(--ink-2)", maxWidth: 680 }}>
        小貘每聊十来轮就会在后台另开一个自己,复盘刚才那段对话,然后往磁盘里写记忆和技艺 ——
        上游是直接写、不留记录、也没有开关。Mo 把这些改动拦下来放这里,你看过再算数。
        你当面说的话（「记住我用 pnpm」）不受影响,照旧立刻生效。
      </p>

      {list && !list.shim_installed && (
        <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 9, fontSize: 12.5,
                      border: "1px solid var(--seal)", color: "var(--seal)", lineHeight: 1.6 }}>
          ⚠ 拦截没装上 —— 后台复盘写的东西目前是直接落盘的。请看引擎日志。
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26, marginTop: 26, alignItems: "start" }}>
        <TapeCard tapeLeft={true} tapeRotate="2deg" style={{ padding: "22px 24px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
            <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650 }}>等你定夺</span>
            {!!items.length && (
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                {items.length} 项{bg ? ` · 其中 ${bg} 项是它自己想改的` : ""}
              </span>
            )}
          </div>

          {items.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.7 }}>
              没有待办。它最近没打算改自己什么。
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflowY: "auto" }}>
              {items.map((it) => (
                <div key={`${it.kind}:${it.id}`} onClick={() => view(it)} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                  border: "1px solid var(--line)", borderRadius: 8, cursor: "pointer",
                  background: "var(--card)",
                }}>
                  <span style={{ fontSize: 10.5, color: "var(--ink-3)", border: "1px solid var(--line-2)",
                                 borderRadius: 99, padding: "1px 7px", flexShrink: 0 }}>
                    {KIND_LABEL[it.kind] ?? it.kind}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace", display: "block",
                                   whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</span>
                    {it.summary && <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{it.summary}</span>}
                  </span>
                  <span style={{ fontSize: 10.5, flexShrink: 0,
                                 color: it.origin === "background_review" ? "var(--moon)" : "var(--ink-3)" }}>
                    {ORIGIN_LABEL[it.origin] ?? it.origin}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--ink-3)", flexShrink: 0 }}>{fmt(it.at)}</span>
                </div>
              ))}
            </div>
          )}
          {notice && <div style={{ fontSize: 11.5, color: "var(--moss)", marginTop: 10 }}>{notice}</div>}
        </TapeCard>

        <TapeCard tapeLeft={false} tapeRotate="-2deg" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650, marginBottom: 10 }}>后台复盘</div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer" }}>
            <input type="checkbox" checked={!!list?.background_only}
                   onChange={(e) => moPort && act(setPendingPolicy(moPort, e.target.checked),
                     () => e.target.checked ? "后台改动会先到这儿" : "后台改动恢复直接落盘")} />
            后台改动先经过我
          </label>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.7 }}>
            关掉它,后台复盘写的记忆和技艺会像上游那样直接落盘。
          </div>

          {rv && (
            <div style={{ borderTop: "1px dashed var(--line)", marginTop: 14, paddingTop: 12 }}>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 8 }}>多久复盘一次</div>
              <div style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 12, color: "var(--ink-2)" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  记忆每
                  <input type="number" min={0} max={10000} defaultValue={rv.memory_nudge_interval ?? 10} style={numIn}
                         onBlur={(e) => moPort && act(setReviewIntervals(moPort, { memory: Number(e.target.value) }), () => "已保存")} />
                  轮
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  技艺每
                  <input type="number" min={0} max={10000} defaultValue={rv.skill_nudge_interval ?? 10} style={numIn}
                         onBlur={(e) => moPort && act(setReviewIntervals(moPort, { skills: Number(e.target.value) }), () => "已保存")} />
                  轮
                </label>
              </div>
              {/* There is no background_review.enabled flag anywhere in the
                  core. Saying "set it very high" is the honest instruction;
                  implying a toggle exists would not be. */}
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.7 }}>
                上游没有「关掉后台复盘」这个开关 —— 把这两个数字调得很大,是唯一的关法。
              </div>
            </div>
          )}

          <div style={{ borderTop: "1px dashed var(--line)", marginTop: 14, paddingTop: 12 }}>
            <button onClick={() => setShowLog((v) => !v)} style={btn}>
              {showLog ? "收起" : "展开"}复盘记录（{log.length}）
            </button>
            {showLog && (
              <div style={{ marginTop: 10, maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                {log.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.7 }}>
                    还没有记录。从现在起它每次复盘做了什么都会记在这里 ——
                    以前这些动作只在终端里闪一下就没了。
                  </div>
                ) : log.map((e, i) => (
                  <div key={i} style={{ fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.6 }}>
                    <span style={{ color: "var(--ink-3)", fontFamily: "'JetBrains Mono', monospace" }}>{fmt(e.at)}</span>
                    {e.actions.map((a, j) => <div key={j} style={{ marginLeft: 8 }}>· {a}</div>)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </TapeCard>
      </div>

      {/* ---- staged write modal ---- */}
      {open && (
        <div onClick={() => setOpen(null)} style={{
          position: "fixed", inset: 0, background: "oklch(20% 0.02 60 / 0.45)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 40,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "var(--card)", borderRadius: 12, boxShadow: "var(--shadow)",
            width: "min(820px, 92vw)", maxHeight: "84vh", display: "flex", flexDirection: "column",
            border: "1px solid var(--line)",
          }}>
            <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, fontWeight: 650 }}>
                {open._item?.title}
              </span>
              <span style={{ fontSize: 11.5, color: open.origin === "background_review" ? "var(--moon)" : "var(--ink-3)" }}>
                {ORIGIN_LABEL[open.origin] ?? open.origin}
              </span>
              <span style={{ marginLeft: "auto", cursor: "pointer", color: "var(--ink-3)", fontSize: 18 }} onClick={() => setOpen(null)}>×</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px" }}>
              {open.summary && <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 12 }}>{open.summary}</div>}
              <pre style={{ margin: 0, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {open.diff
                  ? open.diff.split("\n").map((ln: string, i: number) => (
                      <div key={i} style={{
                        color: ln.startsWith("+") && !ln.startsWith("+++") ? "var(--moss)"
                          : ln.startsWith("-") && !ln.startsWith("---") ? "var(--seal)"
                          : "var(--ink-2)",
                      }}>{ln || " "}</div>
                    ))
                  : JSON.stringify(open.payload ?? {}, null, 2)}
              </pre>
            </div>
            <div style={{ padding: "14px 22px", borderTop: "1px solid var(--line)", display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <button disabled={busy} onClick={() => moPort && act(rejectPending(moPort, open.subsystem, open.id), () => "已弃用")} style={{ ...btn, height: 36, padding: "0 16px" }}>弃用</button>
              <button disabled={busy} onClick={() => moPort && act(approvePending(moPort, open.subsystem, open.id), (r) => `${r.message} · 下次启动生效`)} style={{
                height: 36, padding: "0 18px", borderRadius: 9, border: "none", background: "var(--seal)",
                color: "oklch(98% 0.01 85)", fontSize: 13, fontWeight: 600, cursor: "pointer",
                fontFamily: "'Noto Serif SC', serif",
              }}>收下</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
