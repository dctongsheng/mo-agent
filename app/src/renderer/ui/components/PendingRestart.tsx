import React, { useState } from "react";
import { restartGateway, PendingChange } from "../../services/mo-api";

/** 「有 N 项改动等下次启动生效」
 *
 *  Why "启动" and not "新会话": prompt_builder's skills-index LRU key contains
 *  no mtime, and the only things that clear it are write paths — nothing clears
 *  it when a session begins. So a skill written to disk is picked up by a fresh
 *  gateway process, not a fresh conversation. Mo used to claim the latter,
 *  which sent people looking for an effect that wasn't there yet.
 *
 *  Clearing the cache at accept time would fix the label but break the thing
 *  the label protects — a mid-conversation turn would rebuild its prefix and
 *  drop the provider-side prompt cache. So: say what's true, and offer the
 *  restart.
 */
export function PendingRestart({ port, pending }: { port: number | null; pending?: PendingChange[] }) {
  const [busy, setBusy] = useState(false);
  if (!pending || pending.length === 0) return null;

  const restart = () => {
    if (!port || busy) return;
    if (!confirm(`重启引擎让 ${pending.length} 项改动生效？进行中的对话会中断。`)) return;
    setBusy(true);
    restartGateway(port).catch(() => {}).finally(() => setBusy(false));
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, marginTop: 14,
      padding: "9px 14px", borderRadius: 9, fontSize: 12.5,
      border: "1px solid var(--moon)", color: "var(--ink-2)", lineHeight: 1.6,
    }}>
      <span>
        有 <b style={{ color: "var(--moon)" }}>{pending.length}</b> 项改动等下次启动生效
        <span style={{ color: "var(--ink-3)" }}>
          （{pending.slice(0, 3).map((p) => p.skill).join("、")}
          {pending.length > 3 ? ` 等 ${pending.length} 项` : ""}）
        </span>
      </span>
      <button onClick={restart} disabled={busy} style={{
        marginLeft: "auto", border: "1px solid var(--line-2)", background: "transparent",
        color: "var(--ink-2)", borderRadius: 6, fontSize: 11.5, padding: "3px 10px",
        cursor: busy ? "default" : "pointer", whiteSpace: "nowrap",
      }}>{busy ? "重启中…" : "立即生效 · 重启引擎"}</button>
    </div>
  );
}
