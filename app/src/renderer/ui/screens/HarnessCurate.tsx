import React, { useCallback, useEffect, useState } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { TapeCard } from "../components/TapeCard";
import {
  getCuratorStatus, listCuratorSkills, listRetirements, retireSkill, keepSkill,
  listArchivedSkills, restoreArchivedSkill, setCuratorPaused, runCurator,
  setCuratorThresholds, pinSkill,
  CuratorStatus, UsageRow, Retirement, ArchivedSkill,
} from "../../services/mo-api";

function fmtDate(ts?: number | null): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")}`;
}

/** ~4 chars per CJK/English token mix. Rough on purpose — the point is the
 *  order of magnitude, and quoting a precise token count we can't verify
 *  would be the kind of false precision this app avoids elsewhere. */
function approxTokens(chars: number): string {
  const t = Math.round(chars / 4);
  return t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k` : String(t);
}

const PROVENANCE_LABEL: Record<string, string> = {
  bundled: "内置", agent: "自学", hub: "坊里装的",
};

/** Curation · 清点技艺 — surfaces Hermes' curator and gates its one
 *  destructive step. */
export function HarnessCurate() {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const [status, setStatus] = useState<CuratorStatus | null>(null);
  const [props, setProps] = useState<Retirement[]>([]);
  const [archived, setArchived] = useState<ArchivedSkill[]>([]);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLedger, setShowLedger] = useState(false);

  const refresh = useCallback(() => {
    if (!moPort) return;
    getCuratorStatus(moPort).then(setStatus).catch(() => {});
    listRetirements(moPort, "proposed").then((r) => setProps(r.data)).catch(() => {});
    listArchivedSkills(moPort).then((r) => setArchived(r.data)).catch(() => {});
    listCuratorSkills(moPort).then((r) => setRows(r.data)).catch(() => {});
  }, [moPort]);

  useEffect(() => { refresh(); }, [refresh]);

  const act = (p: Promise<any>, ok: (r: any) => string) => {
    setBusy(true);
    p.then((r) => setNotice(ok(r)))
      .catch(() => setNotice("操作失败"))
      .finally(() => { setBusy(false); refresh(); });
  };

  const retire = (skill: string) => {
    if (!moPort) return;
    if (!confirm(`把「${skill}」收进箱底？它的目录会移到 .archive/，随时可以取回来。`)) return;
    act(retireSkill(moPort, skill), (r) => `${r.message} · 下次启动生效`);
  };
  const keep = (skill: string, pin: boolean) => {
    if (!moPort) return;
    act(keepSkill(moPort, skill, pin), (r) => r.message);
  };
  const restore = (skill: string) => {
    if (!moPort) return;
    act(restoreArchivedSkill(moPort, skill), (r) =>
      r.message + (r.drifted_from_head ? " · 注意：取回来的和上次采纳的版本不一样" : "") + " · 下次启动生效");
  };

  const reclaimable = status?.proposed_chars ?? 0;

  const lbl: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: "var(--ink-2)" };
  const numIn: React.CSSProperties = { width: 58, height: 26, borderRadius: 6, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-1)", padding: "0 6px", fontSize: 12 };
  const btn: React.CSSProperties = { border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink-2)", borderRadius: 6, fontSize: 11, padding: "3px 9px", cursor: "pointer" };

  return (
    <div style={{ marginTop: 48 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "var(--seal)", fontFamily: "'JetBrains Mono', monospace" }}>
        CURATION · 清点技艺
      </div>
      <h2 style={{ margin: "8px 0 6px", fontFamily: "'Noto Serif SC', serif", fontSize: 21, fontWeight: 650 }}>
        哪些方子，已经很久没翻开了。
      </h2>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: "var(--ink-2)", maxWidth: 660 }}>
        上游的管家会在方子闲置 90 天后自己把它收进箱底 —— 不问、不留痕迹。
        Mo 把这一步改成了提案：收不收，你说了算。收起来的方子只是移进 <code>.archive/</code>，从不删除。
      </p>

      {/* A guard that silently failed to install would leave the UI claiming
          protection that isn't there. Say so loudly. */}
      {status && !status.guard_installed && (
        <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 9, fontSize: 12.5,
                      border: "1px solid var(--seal)", color: "var(--seal)", lineHeight: 1.6 }}>
          ⚠ 护栏没装上。{status.clamped
            ? "已把归档期限钉成 100 年作为兜底 —— 定时器够不着，但这是退而求其次。"
            : "定时器仍然活着，可能会自己收走方子。请看引擎日志。"}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26, marginTop: 26, alignItems: "start" }}>
        {/* ---- status + controls ---- */}
        <TapeCard tapeLeft={true} tapeRotate="2deg" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650, marginBottom: 12 }}>台账</div>

          {status ? (
            <>
              <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.9 }}>
                全部 <b>{status.counts.total ?? 0}</b> 张 ·
                三十天没动过 <b>{status.counts.stale ?? 0}</b> 张 ·
                待你定夺 <b style={{ color: "var(--seal)" }}>{status.counts.proposed ?? 0}</b> 张
                {!!status.counts.pinned && <> · 钉住 {status.counts.pinned} 张</>}
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4, lineHeight: 1.7 }}>
                这些方子的名字和描述每次开口都要背一遍，合计约 {approxTokens(status.index_chars)} token。
              </div>
              {status.last_run_summary && (
                <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 8, fontFamily: "'JetBrains Mono', monospace" }}>
                  上次清点：{status.last_run_summary}（共 {status.run_count} 次）
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
                <button disabled={busy} onClick={() => moPort && act(runCurator(moPort, true), (r) => `看过了：会动 ${r.proposed ?? 0} 张`)} style={btn}>只看看会动哪些</button>
                <button disabled={busy} onClick={() => moPort && act(runCurator(moPort, false), (r) => `清点完成：新增 ${r.proposed ?? 0} 条提案`)} style={btn}>现在清点一次</button>
                <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-2)", cursor: "pointer" }}>
                  <input type="checkbox" checked={!!status.paused}
                         onChange={(e) => moPort && act(setCuratorPaused(moPort, e.target.checked), () => e.target.checked ? "已暂停清点" : "已恢复清点")} />
                  暂停清点
                </label>
              </div>

              <div style={{ borderTop: "1px dashed var(--line)", marginTop: 16, paddingTop: 14, display: "flex", gap: 18 }}>
                <label style={lbl}>闲置多少天算“搁下了”
                  <input type="number" min={1} max={3650} defaultValue={status.stale_after_days ?? 30} style={numIn}
                         onBlur={(e) => moPort && act(setCuratorThresholds(moPort, { stale_after_days: Number(e.target.value) }), () => "已保存")} />
                </label>
                <label style={lbl}>多少天后提议收起
                  <input type="number" min={1} max={36500} defaultValue={status.archive_after_days ?? 90} style={numIn}
                         onBlur={(e) => moPort && act(setCuratorThresholds(moPort, { archive_after_days: Number(e.target.value) }), () => "已保存")} />
                </label>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: "var(--ink-3)" }}>读不到清点状态。</div>
          )}
          {notice && <div style={{ fontSize: 11.5, color: "var(--moss)", marginTop: 10, lineHeight: 1.6 }}>{notice}</div>}
        </TapeCard>

        {/* ---- proposals ---- */}
        <TapeCard tapeLeft={false} tapeRotate="-2deg" style={{ padding: "22px 24px" }}>
          <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 16, fontWeight: 650 }}>待退休</div>
          {props.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--ink-3)", margin: "4px 0 12px", lineHeight: 1.7 }}>
              收起这 {props.length} 张，每次开口少背约 {approxTokens(reclaimable)} token。
              <div style={{ marginTop: 3 }}>
                其中一些是之前几次自动清点标下的 —— 那几次没有告诉你。
              </div>
            </div>
          )}

          {props.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 10 }}>没有待定夺的方子。</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 400, overflowY: "auto" }}>
              {props.map((p) => (
                <div key={p.skill} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>{p.skill}</span>
                    <span style={{ fontSize: 10.5, color: "var(--ink-3)", border: "1px solid var(--line-2)", borderRadius: 99, padding: "1px 7px" }}>
                      {PROVENANCE_LABEL[p.provenance ?? ""] ?? p.provenance}
                    </span>
                    {p.reason === "agent-delete" && (
                      <span style={{ fontSize: 10.5, color: "var(--moon)" }}>小貘想删掉它</span>
                    )}
                  </div>
                  {p.description && (
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 3, lineHeight: 1.5 }}>{p.description}</div>
                  )}
                  <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>
                    {p.use_count ? `用过 ${p.use_count} 次` : "从未用过"}
                    {p.days_idle != null && ` · 已闲置 ${p.days_idle} 天`}
                    {!!p.skill_md_chars && ` · 占常驻提示约 ${approxTokens(p.skill_md_chars)} token`}
                    {p.has_version_history && " · 有改写历史"}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button disabled={busy} onClick={() => retire(p.skill)} style={{ ...btn, borderColor: "var(--seal)", color: "var(--seal)" }}>收起来</button>
                    <button disabled={busy} onClick={() => keep(p.skill, false)} style={btn}>留着</button>
                    <button disabled={busy} onClick={() => keep(p.skill, true)} style={btn}>钉住不再问</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ---- archived ---- */}
          <div style={{ borderTop: "1px dashed var(--line)", marginTop: 18, paddingTop: 14 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>已收起的方子</div>
            {archived.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>还没有收起过任何方子。</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 160, overflowY: "auto" }}>
                {archived.map((a) => (
                  <div key={a.name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: "var(--ink-2)" }}>
                    <span style={{ flex: 1 }}>{a.name}</span>
                    {a.drifted_from_head && <span style={{ fontSize: 10.5, color: "var(--moon)" }}>与上次采纳不同</span>}
                    <button disabled={busy} onClick={() => restore(a.name)} style={btn}>取回来</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TapeCard>
      </div>

      {/* ---- full usage ledger ---- */}
      <div style={{ marginTop: 20 }}>
        <button onClick={() => setShowLedger((v) => !v)} style={{ ...btn, fontSize: 12 }}>
          {showLedger ? "收起" : "展开"}全部技艺 · 使用台账（{rows.length}）
        </button>
        {showLedger && (
          <TapeCard tapeLeft={true} tapeRotate="1deg" style={{ padding: "18px 22px", marginTop: 12 }}>
            <div style={{ maxHeight: 420, overflowY: "auto", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
              {rows.map((r) => (
                <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderBottom: "1px solid var(--line)", color: "var(--ink-2)" }}>
                  <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                  {r.protected && <span style={{ fontSize: 10, color: "var(--moss)" }}>受保护</span>}
                  {r.pinned && <span style={{ fontSize: 10, color: "var(--indigo)" }}>已钉住</span>}
                  <span style={{ fontSize: 10.5, color: "var(--ink-3)", width: 46 }}>{PROVENANCE_LABEL[r.provenance ?? ""] ?? ""}</span>
                  <span style={{ fontSize: 11, color: r.state === "stale" ? "var(--moon)" : "var(--ink-3)", width: 40 }}>{r.state}</span>
                  <span style={{ fontSize: 11, color: "var(--ink-3)", width: 70, textAlign: "right" }}>
                    {r.days_idle != null ? `${r.days_idle} 天` : "—"}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--ink-3)", width: 60, textAlign: "right" }}>
                    {r.use_count ? `用 ${r.use_count}` : "未用过"}
                  </span>
                  {moPort && (
                    <button onClick={() => act(pinSkill(moPort, r.name, !r.pinned), () => r.pinned ? "已取消钉住" : "已钉住")} style={{ ...btn, fontSize: 10, padding: "1px 7px" }}>
                      {r.pinned ? "取消钉住" : "钉住"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </TapeCard>
        )}
      </div>
    </div>
  );
}
