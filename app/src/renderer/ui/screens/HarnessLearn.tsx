import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { DialogShell, Panel, StatusBadge } from "../components/EvolveUi";
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
export function HarnessLearn({ active = true }: { active?: boolean } = {}) {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const [status, setStatus] = useState<LearnStatus | null>(null);
  const [drafts, setDrafts] = useState<LearnDraft[]>([]);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<LearnDraft | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logText, setLogText] = useState<string | null>(null);
  const [loading, setLoading] = useState(active);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const [draftsFailed, setDraftsFailed] = useState(false);
  const activeRef = useRef(active);
  const refreshSeq = useRef(0);
  const detailSeq = useRef(0);
  activeRef.current = active;

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    if (!activeRef.current) return;
    if (!moPort) {
      setLoading(false);
      setLoadError("本机进化服务尚未连接，暂时无法读取学习状态。");
      setDraftsFailed(true);
      return;
    }

    setLoading(true);
    const [statusResult, draftsResult] = await Promise.allSettled([
      getLearnStatus(moPort),
      listLearnDrafts(moPort),
    ]);
    if (!activeRef.current || seq !== refreshSeq.current) return;

    const failed: string[] = [];
    if (statusResult.status === "fulfilled") {
      setStatus(statusResult.value);
    } else {
      failed.push("学习引擎状态");
    }
    if (draftsResult.status === "fulfilled") {
      setDrafts(draftsResult.value.data);
      setDraftsLoaded(true);
      setDraftsFailed(false);
    } else {
      failed.push("学习草稿");
      setDraftsFailed(true);
    }
    setLoadError(failed.length
      ? `未能从本机读取${failed.join("、")}。请确认引擎仍在运行。`
      : null);
    setLoading(false);
  }, [moPort]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (active) return;
    refreshSeq.current += 1;
    detailSeq.current += 1;
    setLoading(false);
    setOpen(null);
    setRefusal(null);
    setLogText(null);
  }, [active]);

  // Poll while a turn is in flight — a learn run does real tool work and can
  // take minutes.
  useEffect(() => {
    if (!active || !moPort || !drafts.some((d) => d.status === "running")) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [active, moPort, drafts, refresh]);

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
    const seq = ++detailSeq.current;
    setRefusal(null); setLogText(null);
    getLearnDraft(moPort, id)
      .then((draft) => {
        if (activeRef.current && seq === detailSeq.current) setOpen(draft);
      })
      .catch(() => {});
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

  return (
    <div className="evolve-workbench">
      <div className="evolve-workbench-meta">
        <span className="evolve-eyebrow">LEARN · 教它一手</span>
        {status && (
          <StatusBadge tone={status.ready ? "success" : "warning"}>
            {status.ready ? "可以学" : `未就绪 · ${status.reason}`}
          </StatusBadge>
        )}
      </div>
      <h2 className="evolve-workbench-title">
        把刚做过的事,记成一条方子。
      </h2>
      <p className="evolve-workbench-description">
        给它一个目录、一个网址,或者就说「把刚才那套流程记下来」。它会在沙箱里写一份 SKILL.md,
        你看过再决定收不收 —— 在你点头之前,真正的技艺目录一个字都不会动。
      </p>

      {loadError && (
        <div className="evolve-load-callout is-danger" role="alert">
          <div className="evolve-load-callout__copy">
            <strong>本机学习状态读取失败</strong>
            <div>{loadError}{(status || draftsLoaded) ? " 已读到的内容仍保留。" : ""}</div>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? "重试中…" : "重试"}
          </button>
        </div>
      )}

      <PendingRestart port={moPort} pending={status?.pending} />

      {/* If the vendored authoring standards couldn't be imported, the draft
          was written without the house rules. Say that rather than implying
          they were applied. */}
      {status?.standards === "unavailable" && (
        <div className="evolve-alert is-warning" role="status">
          ⚠ 读不到 Hermes 的撰写规范,这次用的是简化提示 —— 格式可能不合规矩。
        </div>
      )}

      <div className="evolve-panel-grid">
        <Panel title="学点什么">
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder={"把刚才折腾 arxiv 那套流程记下来\n或：~/code/my-tool 这个目录，学一下怎么用\n或：https://… 这篇文档"}
            rows={5}
            className="evolve-textarea"
          />
          <button
            type="button"
            onClick={start}
            disabled={busy || !request.trim() || !status?.ready}
            className="evolve-primary-button evolve-button--full evolve-learn-submit"
          >
            {busy ? "启动中…" : "学一下 →"}
          </button>
          <div className="evolve-form-hint evolve-form-hint--spaced">
            在沙箱 profile 里跑一次完整的对话,最多 {status?.timeout ?? 600} 秒。
            它会自己读资料、写文件。
          </div>
          {notice && <div className="evolve-notice is-success">{notice}</div>}
        </Panel>

        <Panel title="草稿">
          {loading && !draftsLoaded ? (
            <div className="evolve-state-text">正在读取本机学习草稿……</div>
          ) : !draftsLoaded ? (
            <div className="evolve-state-text is-error">
              学习草稿尚未读取成功，不能判断现在是否为空。
            </div>
          ) : draftsFailed && drafts.length === 0 ? (
            <div className="evolve-state-text is-error">
              本次没有读到学习草稿，不能确认现在是否为空。
            </div>
          ) : drafts.length === 0 ? (
            <div className="evolve-state-text">还没教过它什么。</div>
          ) : null}
          <div className="evolve-record-list evolve-scroll-list">
            {drafts.map((d) => (
              <div
                key={d.id}
                className="evolve-record-row evolve-record-row--four"
                style={{ "--status-color": STATUS_COLOR[d.status] } as React.CSSProperties}
              >
                <span className={`evolve-record-dot${d.status === "running" ? " is-running" : ""}`} />
                <button
                  type="button"
                  className="evolve-record-main"
                  disabled={d.status === "running"}
                  onClick={() => view(d.id)}
                >
                  <span className="evolve-record-name">
                    {d.skill_name || d.request.slice(0, 40)}
                  </span>
                  {d.description && (
                    <span className="evolve-record-description">{d.description}</span>
                  )}
                  {d.error && <span className="evolve-record-description is-error">{d.error}</span>}
                </button>
                <span className="evolve-record-status">{STATUS_LABEL[d.status]}</span>
                <span className="evolve-record-time">{fmt(d.created_at)}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* ---- draft modal ---- */}
      {open && (
        <DialogShell
          title={open.skill?.name || "（没有产出）"}
          onClose={() => setOpen(null)}
          footer={(
            <>
              <button
                type="button"
                className="evolve-secondary-button evolve-dialog-footer-leading"
                onClick={() => moPort && getLearnLog(moPort, open.id)
                  .then((r) => setLogText(r.data || "(日志为空)"))}
              >
                查看日志
              </button>
              {refusal && <span className="evolve-dialog-footer-message">{refusal}</span>}
              {open.status === "done" && (
                <div className="evolve-dialog-footer-actions">
                  <button
                    type="button"
                    className="evolve-secondary-button"
                    onClick={() => moPort && rejectLearnDraft(moPort, open.id)
                      .then(() => { setOpen(null); refresh(); })}
                  >
                    弃用
                  </button>
                  {hardBlocked ? (
                    <button type="button" disabled className="evolve-secondary-button">
                      需要重写才能收下
                    </button>
                  ) : refusal ? (
                    <button
                      type="button"
                      className="evolve-secondary-button is-danger"
                      onClick={() => accept(true)}
                    >
                      仍要收下
                    </button>
                  ) : (
                    <button type="button" className="evolve-primary-button" onClick={() => accept(false)}>
                      收下 · 写进技艺
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        >
            <div className="evolve-dialog-meta">
              {open.skill?.category && <span>{open.skill.category}</span>}
              <div>
                你说的是：{open.request}
              </div>
            </div>

              {/* The description counter. This rule is violated constantly and
                  fails silently — over 60 chars the system-prompt index
                  truncates it and the skill never routes, while still looking
                  perfectly installed. */}
              {open.skill && (
                <div className={`evolve-description-check${descOver ? " is-error" : ""}`}>
                  <div className="evolve-description-check__header">
                    <strong>description</strong>
                    <span className="evolve-description-check__counter">
                      {desc.length}/{MAX_DESC}
                    </span>
                  </div>
                  <div className="evolve-description-check__body">{desc || "（空）"}</div>
                  {descOver && (
                    <div className="evolve-description-check__error">
                      超出的部分会被系统提示索引悄悄截掉 —— 技艺装上了、列表里看得见,却永远不会被用到。
                      让它重写一遍。
                    </div>
                  )}
                </div>
              )}

              {open.staged && (
                <div className="evolve-dialog-note">
                  这份草稿是从暂存队列里取出来的（沙箱开了写入审批），内容完整。
                </div>
              )}

              {open.collides_with && (
                <div className="evolve-alert is-warning evolve-alert--dialog">
                  已经有一条叫「{open.collides_with}」的技艺 —— 收下会覆盖它（旧的会先存档，可回退）。
                </div>
              )}

              {!!open.findings?.length && (
                <div className="evolve-alert is-warning evolve-alert--dialog">
                  <strong>新写的内容里有 {open.findings.length} 处需要过目</strong>
                  {open.findings.slice(0, 5).map((f, i) => (
                    <div key={i} className={`evolve-finding${f.severity === "high" ? " is-error" : ""}`}>
                      <span className="evolve-finding__label">
                        [{f.severity === "high" ? "高危" : "留意"} · {f.pattern}]
                      </span>{" "}{f.why}
                    </div>
                  ))}
                </div>
              )}

              {open.skill?.files?.length ? (
                <div className="evolve-dialog-files">
                  附带文件：{open.skill.files.map((f) => f.path).join("、")}
                </div>
              ) : null}

              {logText !== null ? (
                <pre className="evolve-dialog-code">{logText}</pre>
              ) : open.skill?.content ? (
                <pre className="evolve-dialog-code">
                  {open.skill.content}
                </pre>
              ) : (
                <div className="evolve-state-text">这次没有写出技艺，看看日志。</div>
              )}
        </DialogShell>
      )}
    </div>
  );
}
