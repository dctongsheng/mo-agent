import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { useAppState } from "../appState";
import { DialogShell, Panel } from "../components/EvolveUi";
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
export function HarnessInbox({ active = true }: { active?: boolean } = {}) {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const s = useAppState();
  const [list, setList] = useState<PendingList | null>(null);
  const [log, setLog] = useState<ReviewLogEntry[]>([]);
  const [open, setOpen] = useState<any | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [loading, setLoading] = useState(active);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [logLoaded, setLogLoaded] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const [logFailed, setLogFailed] = useState(false);
  const activeRef = useRef(active);
  const refreshSeq = useRef(0);
  const detailSeq = useRef(0);
  activeRef.current = active;

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    if (!activeRef.current) return;
    if (!moPort) {
      setLoading(false);
      setLoadError("本机进化服务尚未连接，暂时无法读取待办。");
      setListFailed(true);
      setLogFailed(true);
      return;
    }

    setLoading(true);
    const [listResult, logResult] = await Promise.allSettled([
      listPending(moPort),
      getReviewLog(moPort),
    ]);
    if (!activeRef.current || seq !== refreshSeq.current) return;

    const failed: string[] = [];
    if (listResult.status === "fulfilled") {
      setList(listResult.value);
      setListFailed(false);
    } else {
      failed.push("待办清单");
      setListFailed(true);
    }
    if (logResult.status === "fulfilled") {
      setLog(logResult.value.data);
      setLogLoaded(true);
      setLogFailed(false);
    } else {
      failed.push("复盘记录");
      setLogFailed(true);
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
    setShowLog(false);
  }, [active]);

  const act = (p: Promise<any>, ok: (r: any) => string) => {
    setBusy(true);
    p.then((r) => setNotice(ok(r))).catch(() => setNotice("操作失败"))
      .finally(() => { setBusy(false); setOpen(null); refresh(); });
  };

  const view = (it: PendingItem) => {
    if (!moPort) return;
    const seq = ++detailSeq.current;
    if (it.kind === "retirement") { s.goEvolve("curation"); return; }
    if (it.kind === "learn-draft") { s.goEvolve("learn"); return; }
    getPendingDetail(moPort, it.subsystem!, it.id)
      .then((d) => {
        if (activeRef.current && seq === detailSeq.current) setOpen({ ...d, _item: it });
      })
      .catch(() => {});
  };

  const items = list?.data ?? [];
  const bg = list?.counts?.background ?? 0;
  const rv = list?.review;

  return (
    <div className="evolve-workbench">
      <div className="evolve-eyebrow">PENDING · 待办</div>
      <h2 className="evolve-workbench-title">
        它想改自己的地方,都在这儿等你点头。
      </h2>
      <p className="evolve-workbench-description">
        小貘每聊十来轮就会在后台另开一个自己,复盘刚才那段对话,然后往磁盘里写记忆和技艺 ——
        上游是直接写、不留记录、也没有开关。Mo 把这些改动拦下来放这里,你看过再算数。
        你当面说的话（「记住我用 pnpm」）不受影响,照旧立刻生效。
      </p>

      {list && !list.shim_installed && (
        <div className="evolve-alert is-danger" role="alert">
          ⚠ 拦截没装上 —— 后台复盘写的东西目前是直接落盘的。请看引擎日志。
        </div>
      )}

      {loadError && (
        <div className="evolve-load-callout is-danger" role="alert">
          <div className="evolve-load-callout__copy">
            <strong>本机待办读取失败</strong>
            <div>{loadError}{(list || logLoaded) ? " 已读到的内容仍保留。" : ""}</div>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? "重试中…" : "重试"}
          </button>
        </div>
      )}

      <div className="evolve-panel-grid">
        <Panel
          title="等你定夺"
          actions={items.length > 0 ? (
            <span className="evolve-panel-count">
              {items.length} 项{bg ? ` · 其中 ${bg} 项是它自己想改的` : ""}
            </span>
          ) : undefined}
        >

          {loading && list === null ? (
            <div className="evolve-state-text">
              正在读取本机待办……
            </div>
          ) : list === null ? (
            <div className="evolve-state-text is-error">
              待办清单尚未读取成功，不能判断现在是否为空。
            </div>
          ) : listFailed && items.length === 0 ? (
            <div className="evolve-state-text is-error">
              本次没有读到待办清单，不能确认现在是否为空。
            </div>
          ) : items.length === 0 ? (
            <div className="evolve-state-text">
              没有待办。它最近没打算改自己什么。
            </div>
          ) : (
            <div className="evolve-review-list">
              {items.map((it) => (
                <div key={`${it.kind}:${it.id}`} className="evolve-review-row">
                  <span className="evolve-chip evolve-chip--compact">
                    {KIND_LABEL[it.kind] ?? it.kind}
                  </span>
                  <button type="button" className="evolve-record-main" onClick={() => view(it)}>
                    <span className="evolve-record-name">{it.title}</span>
                    {it.summary && <span className="evolve-record-description">{it.summary}</span>}
                  </button>
                  <span className={`evolve-review-origin${it.origin === "background_review" ? " is-warning" : ""}`}>
                    {ORIGIN_LABEL[it.origin] ?? it.origin}
                  </span>
                  <span className="evolve-record-time">{fmt(it.at)}</span>
                </div>
              ))}
            </div>
          )}
          {notice && <div className="evolve-notice is-success">{notice}</div>}
        </Panel>

        <Panel title="后台复盘">
          <label className="evolve-check">
            <input type="checkbox" checked={!!list?.background_only}
                   disabled={!list}
                   onChange={(e) => moPort && act(setPendingPolicy(moPort, e.target.checked),
                     () => e.target.checked ? "后台改动会先到这儿" : "后台改动恢复直接落盘")} />
            后台改动先经过我
          </label>
          <div className="evolve-form-hint">
            关掉它,后台复盘写的记忆和技艺会像上游那样直接落盘。
          </div>

          {rv && (
            <div className="evolve-subsection">
              <div className="evolve-subsection-title">多久复盘一次</div>
              <div className="evolve-inline-fields">
                <label className="evolve-field evolve-field--inline">
                  记忆每
                  <input type="number" min={0} max={10000} defaultValue={rv.memory_nudge_interval ?? 10} className="evolve-number-input"
                         onBlur={(e) => moPort && act(setReviewIntervals(moPort, { memory: Number(e.target.value) }), () => "已保存")} />
                  轮
                </label>
                <label className="evolve-field evolve-field--inline">
                  技艺每
                  <input type="number" min={0} max={10000} defaultValue={rv.skill_nudge_interval ?? 10} className="evolve-number-input"
                         onBlur={(e) => moPort && act(setReviewIntervals(moPort, { skills: Number(e.target.value) }), () => "已保存")} />
                  轮
                </label>
              </div>
              {/* There is no background_review.enabled flag anywhere in the
                  core. Saying "set it very high" is the honest instruction;
                  implying a toggle exists would not be. */}
              <div className="evolve-form-hint">
                上游没有「关掉后台复盘」这个开关 —— 把这两个数字调得很大,是唯一的关法。
              </div>
            </div>
          )}

          <div className="evolve-subsection">
            <button type="button" onClick={() => setShowLog((v) => !v)} className="evolve-secondary-button">
              {showLog ? "收起" : "展开"}复盘记录（{logLoaded && !(logFailed && log.length === 0) ? log.length : "—"}）
            </button>
            {showLog && (
              <div className="evolve-review-log">
                {!logLoaded || (logFailed && log.length === 0) ? (
                  <div className="evolve-state-text is-error">
                    复盘记录尚未读取成功，不能判断是否为空。
                  </div>
                ) : log.length === 0 ? (
                  <div className="evolve-state-text">
                    还没有记录。从现在起它每次复盘做了什么都会记在这里 ——
                    以前这些动作只在终端里闪一下就没了。
                  </div>
                ) : log.map((e, i) => (
                  <div key={i} className="evolve-review-log__entry">
                    <span className="evolve-record-time">{fmt(e.at)}</span>
                    {e.actions.map((a, j) => <div key={j} className="evolve-review-log__action">· {a}</div>)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* ---- staged write modal ---- */}
      {open && (
        <DialogShell
          title={open._item?.title || "待确认改动"}
          onClose={() => setOpen(null)}
          footer={(
            <>
              <button
                type="button"
                disabled={busy}
                className="evolve-secondary-button"
                onClick={() => moPort && act(rejectPending(moPort, open.subsystem, open.id), () => "已弃用")}
              >
                弃用
              </button>
              <button
                type="button"
                disabled={busy}
                className="evolve-primary-button"
                onClick={() => moPort && act(
                  approvePending(moPort, open.subsystem, open.id),
                  (r) => `${r.message} · 下次启动生效`,
                )}
              >
                收下
              </button>
            </>
          )}
        >
          <div className="evolve-dialog-meta">
            <span className={open.origin === "background_review" ? "is-warning" : ""}>
              {ORIGIN_LABEL[open.origin] ?? open.origin}
            </span>
            {open.summary && <span>{open.summary}</span>}
          </div>
          {open.diff ? (
            <div className="evolve-dialog-code" role="region" aria-label="改动内容">
              {open.diff.split("\n").map((ln: string, i: number) => (
                <div key={i} style={{
                  color: ln.startsWith("+") && !ln.startsWith("+++") ? "var(--moss)"
                    : ln.startsWith("-") && !ln.startsWith("---") ? "var(--seal)"
                    : "var(--ink-2)",
                }}>{ln || " "}</div>
              ))}
            </div>
          ) : (
            <pre className="evolve-dialog-code">{JSON.stringify(open.payload ?? {}, null, 2)}</pre>
          )}
        </DialogShell>
      )}
    </div>
  );
}
