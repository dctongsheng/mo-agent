import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { Panel } from "../components/EvolveUi";
import { PendingRestart } from "../components/PendingRestart";
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
export function HarnessCurate({ active = true }: { active?: boolean } = {}) {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const [status, setStatus] = useState<CuratorStatus | null>(null);
  const [props, setProps] = useState<Retirement[]>([]);
  const [archived, setArchived] = useState<ArchivedSkill[]>([]);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLedger, setShowLedger] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const activeRef = useRef(active);
  const refreshSeq = useRef(0);
  activeRef.current = active;

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    if (!activeRef.current) return;
    if (!moPort) {
      setLoading(false);
      setLoadErrors(["status", "proposals", "archived", "ledger"]);
      return;
    }
    setLoading(true);
    setLoadErrors([]);
    const [statusResult, proposalsResult, archivedResult, ledgerResult] = await Promise.allSettled([
      getCuratorStatus(moPort),
      listRetirements(moPort, "proposed"),
      listArchivedSkills(moPort),
      listCuratorSkills(moPort),
    ]);
    if (!activeRef.current || seq !== refreshSeq.current) return;
    const errors: string[] = [];
    if (statusResult.status === "fulfilled") setStatus(statusResult.value);
    else errors.push("status");
    if (proposalsResult.status === "fulfilled") setProps(proposalsResult.value.data);
    else errors.push("proposals");
    if (archivedResult.status === "fulfilled") setArchived(archivedResult.value.data);
    else errors.push("archived");
    if (ledgerResult.status === "fulfilled") setRows(ledgerResult.value.data);
    else errors.push("ledger");
    setLoadErrors(errors);
    setLoading(false);
  }, [moPort]);

  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (active) return;
    refreshSeq.current += 1;
    setLoading(false);
  }, [active]);

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

  return (
    <div className="evolve-workbench">
      <div className="evolve-eyebrow">CURATION · 清点技艺</div>
      <h2 className="evolve-workbench-title">
        哪些方子，已经很久没翻开了。
      </h2>
      <p className="evolve-workbench-description">
        上游的管家会在方子闲置 90 天后自己把它收进箱底 —— 不问、不留痕迹。
        Mo 把这一步改成了提案：收不收，你说了算。收起来的方子只是移进 <code>.archive/</code>，从不删除。
      </p>

      <PendingRestart port={moPort} pending={status?.pending} />

      {loadErrors.length > 0 && (
        <div className="evolve-load-callout" role="status">
          <span>部分清点台账暂时读不到，已成功读取的内容仍可使用。</span>
          <button type="button" onClick={refresh}>重试</button>
        </div>
      )}

      {/* A guard that silently failed to install would leave the UI claiming
          protection that isn't there. Say so loudly. */}
      {status && !status.guard_installed && (
        <div className="evolve-alert is-danger" role="alert">
          ⚠ 护栏没装上。{status.clamped
            ? "已把归档期限钉成 100 年作为兜底 —— 定时器够不着，但这是退而求其次。"
            : "定时器仍然活着，可能会自己收走方子。请看引擎日志。"}
        </div>
      )}

      <div className="evolve-panel-grid">
        {/* ---- status + controls ---- */}
        <Panel title="台账">

          {loading && !status ? (
            <div className="evolve-state-text">正在读取清点状态…</div>
          ) : loadErrors.includes("status") && !status ? (
            <div className="evolve-state-text is-error">清点状态读取失败，请重试。</div>
          ) : status ? (
            <>
              <div className="evolve-stat-line">
                全部 <b>{status.counts.total ?? 0}</b> 张 ·
                三十天没动过 <b>{status.counts.stale ?? 0}</b> 张 ·
                待你定夺 <b className="is-error">{status.counts.proposed ?? 0}</b> 张
                {!!status.counts.pinned && <> · 钉住 {status.counts.pinned} 张</>}
              </div>
              <div className="evolve-explainer">
                这些方子的名字和描述每次开口都要背一遍，合计约 {approxTokens(status.index_chars)} token。
              </div>
              {status.last_run_summary && (
                <div className="evolve-mono-note">
                  上次清点：{status.last_run_summary}（共 {status.run_count} 次）
                </div>
              )}

              <div className="evolve-inline-actions evolve-inline-actions--spaced">
                <button type="button" disabled={busy} onClick={() => moPort && act(runCurator(moPort, true), (r) => `看过了：会动 ${r.proposed ?? 0} 张`)} className="evolve-secondary-button">只看看会动哪些</button>
                <button type="button" disabled={busy} onClick={() => moPort && act(runCurator(moPort, false), (r) => `清点完成：新增 ${r.proposed ?? 0} 条提案`)} className="evolve-secondary-button">现在清点一次</button>
                <label className="evolve-check evolve-check--push">
                  <input type="checkbox" checked={!!status.paused}
                         onChange={(e) => moPort && act(setCuratorPaused(moPort, e.target.checked), () => e.target.checked ? "已暂停清点" : "已恢复清点")} />
                  暂停清点
                </label>
              </div>

              <div className="evolve-subsection evolve-inline-fields">
                <label className="evolve-field">闲置多少天算“搁下了”
                  <input type="number" min={1} max={3650} defaultValue={status.stale_after_days ?? 30} className="evolve-number-input"
                         onBlur={(e) => moPort && act(setCuratorThresholds(moPort, { stale_after_days: Number(e.target.value) }), () => "已保存")} />
                </label>
                <label className="evolve-field">多少天后提议收起
                  <input type="number" min={1} max={36500} defaultValue={status.archive_after_days ?? 90} className="evolve-number-input"
                         onBlur={(e) => moPort && act(setCuratorThresholds(moPort, { archive_after_days: Number(e.target.value) }), () => "已保存")} />
                </label>
              </div>
            </>
          ) : (
            <div className="evolve-state-text">读不到清点状态。</div>
          )}
          {notice && <div className="evolve-notice is-success">{notice}</div>}
        </Panel>

        {/* ---- proposals ---- */}
        <Panel title="待退休">
          {props.length > 0 && (
            <div className="evolve-panel-intro">
              收起这 {props.length} 张，每次开口少背约 {approxTokens(reclaimable)} token。
              <div>
                其中一些是之前几次自动清点标下的 —— 那几次没有告诉你。
              </div>
            </div>
          )}

          {loading && props.length === 0 ? (
            <div className="evolve-state-text">正在读取退休提案…</div>
          ) : loadErrors.includes("proposals") && props.length === 0 ? (
            <div className="evolve-state-text is-error">退休提案读取失败，不能判断当前是否为空。</div>
          ) : props.length === 0 ? (
            <div className="evolve-state-text">没有待定夺的方子。</div>
          ) : (
            <div className="evolve-proposal-list">
              {props.map((p) => (
                <div key={p.skill} className="evolve-proposal-card">
                  <div className="evolve-proposal-card__header">
                    <span className="evolve-record-name">{p.skill}</span>
                    <span className="evolve-chip evolve-chip--compact">
                      {PROVENANCE_LABEL[p.provenance ?? ""] ?? p.provenance}
                    </span>
                    {p.reason === "agent-delete" && (
                      <span className="evolve-small-tag is-warning">小貘想删掉它</span>
                    )}
                  </div>
                  {p.description && (
                    <div className="evolve-record-description">{p.description}</div>
                  )}
                  <div className="evolve-proposal-card__meta">
                    {p.use_count ? `用过 ${p.use_count} 次` : "从未用过"}
                    {p.days_idle != null && ` · 已闲置 ${p.days_idle} 天`}
                    {!!p.skill_md_chars && ` · 占常驻提示约 ${approxTokens(p.skill_md_chars)} token`}
                    {p.has_version_history && " · 有改写历史"}
                  </div>
                  <div className="evolve-inline-actions evolve-proposal-card__actions">
                    <button type="button" disabled={busy} onClick={() => retire(p.skill)} className="evolve-secondary-button is-danger">收起来</button>
                    <button type="button" disabled={busy} onClick={() => keep(p.skill, false)} className="evolve-secondary-button">留着</button>
                    <button type="button" disabled={busy} onClick={() => keep(p.skill, true)} className="evolve-secondary-button">钉住不再问</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ---- archived ---- */}
          <div className="evolve-subsection">
            <div className="evolve-subsection-title">已收起的方子</div>
            {loading && archived.length === 0 ? (
              <div className="evolve-state-text">正在读取已收起的方子…</div>
            ) : loadErrors.includes("archived") && archived.length === 0 ? (
              <div className="evolve-state-text is-error">已收起的方子读取失败。</div>
            ) : archived.length === 0 ? (
              <div className="evolve-state-text">还没有收起过任何方子。</div>
            ) : (
              <div className="evolve-compact-list evolve-compact-list--short">
                {archived.map((a) => (
                  <div key={a.name} className="evolve-compact-row">
                    <span className="evolve-compact-name">{a.name}</span>
                    {a.drifted_from_head && <span className="evolve-small-tag is-warning">与上次采纳不同</span>}
                    <button type="button" disabled={busy} onClick={() => restore(a.name)} className="evolve-mini-button">取回来</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* ---- full usage ledger ---- */}
      <div className="evolve-ledger-toggle">
        <button type="button" onClick={() => setShowLedger((v) => !v)} className="evolve-secondary-button">
          {showLedger ? "收起" : "展开"}全部技艺 · 使用台账（{rows.length}）
        </button>
        {showLedger && (
          <div className="evolve-ledger-toggle__panel">
            <Panel title="全部技艺使用台账">
            <div className="evolve-usage-ledger">
              {loadErrors.includes("ledger") && rows.length === 0 ? (
                <div className="evolve-state-text is-error">完整使用台账读取失败，请重试。</div>
              ) : rows.map((r) => (
                <div key={r.name} className="evolve-usage-row">
                  <span className="evolve-compact-name">{r.name}</span>
                  {r.protected && <span className="evolve-small-tag is-success">受保护</span>}
                  {r.pinned && <span className="evolve-small-tag is-info">已钉住</span>}
                  <span className="evolve-usage-row__provenance">{PROVENANCE_LABEL[r.provenance ?? ""] ?? ""}</span>
                  <span className={`evolve-usage-row__state${r.state === "stale" ? " is-warning" : ""}`}>{r.state}</span>
                  <span className="evolve-usage-row__metric">
                    {r.days_idle != null ? `${r.days_idle} 天` : "—"}
                  </span>
                  <span className="evolve-usage-row__metric">
                    {r.use_count ? `用 ${r.use_count}` : "未用过"}
                  </span>
                  {moPort && (
                    <button type="button" onClick={() => act(pinSkill(moPort, r.name, !r.pinned), () => r.pinned ? "已取消钉住" : "已钉住")} className="evolve-mini-button">
                      {r.pinned ? "取消钉住" : "钉住"}
                    </button>
                  )}
                </div>
              ))}
            </div>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}
