import React, { useEffect, useRef, useState, useCallback } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import { DialogShell, Panel, StatusBadge } from "../components/EvolveUi";
import {
  getFinetuneStatus, runFinetune, listFinetuneRuns, getFinetuneRunLog,
  FinetuneStatus, FinetuneRun,
} from "../../services/mo-api";

function fmt(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const SLABEL: Record<string, string> = { running: "微调中…", done: "完成", failed: "失败" };
const SCOLOR: Record<string, string> = { running: "var(--moon)", done: "var(--moss)", failed: "var(--seal)" };
const FINETUNE_CONNECTION_ERROR = "无法连接到本地微调引擎，请确认桌面服务已启动。";

/** 模型自进化 · 权重微调 — gated on datasets-ready + local-model-active. */
export function ModelEvolve({ onGoSettings, active = true }: { onGoSettings: () => void; active?: boolean }) {
  const moPort = useAppSelector((st) => moPortOf(st.gateway.state));
  const [status, setStatus] = useState<FinetuneStatus | null>(null);
  const [runs, setRuns] = useState<FinetuneRun[]>([]);
  const [steps, setSteps] = useState(10);
  const [busy, setBusy] = useState(false);
  const [logRun, setLogRun] = useState<FinetuneRun | null>(null);
  const [logText, setLogText] = useState("");
  const [loading, setLoading] = useState({ status: true, runs: true });
  const [errors, setErrors] = useState<{ status: string | null; runs: string | null }>({ status: null, runs: null });
  const activeRef = useRef(active);
  const statusSeq = useRef(0);
  const runsSeq = useRef(0);
  const logSeq = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  activeRef.current = active;

  const refresh = useCallback(() => {
    if (!activeRef.current) return;
    if (!moPort) {
      statusSeq.current += 1;
      runsSeq.current += 1;
      setLoading({ status: false, runs: false });
      setErrors({ status: FINETUNE_CONNECTION_ERROR, runs: FINETUNE_CONNECTION_ERROR });
      return;
    }
    const nextStatusSeq = ++statusSeq.current;
    const nextRunsSeq = ++runsSeq.current;
    setLoading({ status: true, runs: true });
    setErrors({ status: null, runs: null });
    getFinetuneStatus(moPort).then((result) => {
      if (activeRef.current && nextStatusSeq === statusSeq.current) setStatus(result);
    }).catch(() => {
      if (activeRef.current && nextStatusSeq === statusSeq.current) {
        setErrors((current) => ({ ...current, status: "读取微调状态失败，请检查连接后重试。" }));
      }
    }).finally(() => {
      if (activeRef.current && nextStatusSeq === statusSeq.current) {
        setLoading((current) => ({ ...current, status: false }));
      }
    });
    listFinetuneRuns(moPort).then((result) => {
      if (activeRef.current && nextRunsSeq === runsSeq.current) setRuns(result.data);
    }).catch(() => {
      if (activeRef.current && nextRunsSeq === runsSeq.current) {
        setErrors((current) => ({ ...current, runs: "读取微调记录失败，请检查连接后重试。" }));
      }
    }).finally(() => {
      if (activeRef.current && nextRunsSeq === runsSeq.current) {
        setLoading((current) => ({ ...current, runs: false }));
      }
    });
  }, [moPort]);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  // The surrounding workbench remains mounted to preserve the user's chosen
  // step count. Only temporary log UI is discarded while it is hidden.
  useEffect(() => {
    if (active) return;
    statusSeq.current += 1;
    runsSeq.current += 1;
    logSeq.current += 1;
    if (refreshTimer.current != null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    setLoading({ status: false, runs: false });
    setLogRun(null);
  }, [active]);

  useEffect(() => () => {
    if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
  }, []);

  useEffect(() => {
    if (!active || !moPort) return;
    if (!runs.some((r) => r.status === "running")) return;
    const t = setInterval(() => {
      const seq = ++runsSeq.current;
      listFinetuneRuns(moPort).then((result) => {
        if (!activeRef.current || seq !== runsSeq.current) return;
        setRuns(result.data);
        setErrors((current) => ({ ...current, runs: null }));
      }).catch(() => {
        if (activeRef.current && seq === runsSeq.current) {
          setErrors((current) => ({ ...current, runs: "自动刷新失败，请重试。" }));
        }
      });
    }, 4000);
    return () => clearInterval(t);
  }, [active, moPort, runs]);

  const start = () => {
    if (!moPort || !status?.can_start || busy) return;
    setBusy(true);
    runFinetune(moPort, "sft", steps).then((r) => {
      if (!r.ok) alert(`无法开始：${r.reason ?? "未知"}`);
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        if (activeRef.current) refresh();
      }, 500);
    }).catch(() => {}).finally(() => setBusy(false));
  };

  const openLog = (run: FinetuneRun) => {
    if (!moPort) return;
    const seq = ++logSeq.current;
    setLogRun(run); setLogText("加载中…");
    getFinetuneRunLog(moPort, run.id).then((r) => {
      if (activeRef.current && seq === logSeq.current) setLogText(r.data || "(日志为空)");
    }).catch(() => {
      if (activeRef.current && seq === logSeq.current) setLogText("(读取失败)");
    });
  };
  useEffect(() => {
    if (!active || !moPort || !logRun) return;
    const live = (runs.find((r) => r.id === logRun.id)?.status ?? logRun.status) === "running";
    if (!live) return;
    const t = setInterval(() => {
      const seq = ++logSeq.current;
      getFinetuneRunLog(moPort, logRun.id).then((r) => {
        if (activeRef.current && seq === logSeq.current) setLogText(r.data || "");
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [active, moPort, logRun, runs]);

  const Gate = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className={`evolve-finetune-gate${ok ? " is-ready" : ""}`}>
      <span className="evolve-finetune-gate__mark" aria-hidden="true">{ok ? "✓" : "·"}</span>
      <span>{label}</span>
    </div>
  );

  const RequestNotice = ({ loading: waiting, error, label }: { loading: boolean; error: string | null; label: string }) => {
    if (!waiting && !error) return null;
    return (
      <div role={error ? "alert" : "status"} className={`evolve-request-notice${error ? " is-error" : ""}`}>
        {error ?? `正在读取${label}…`}
        {error && <button type="button" onClick={refresh}>重试</button>}
      </div>
    );
  };

  return (
    <div hidden={!active} className="evolve-model-panel">
      <Panel
        title="模型自进化 · 权重微调"
        eyebrow="MODEL · LoRA/GRPO"
        actions={status && (
          <StatusBadge tone={status.mode === "real" ? "success" : "warning"}>
            {status.mode === "real" ? "可真训练" : "脚手架"}
          </StatusBadge>
        )}
      >
        <RequestNotice loading={loading.status} error={errors.status} label="微调状态" />
        <div className="evolve-body-copy">
          用攒下的对话轨迹给本地模型做 LoRA 微调,真正改写权重。需满足两个开启条件:
        </div>

        {/* gates */}
        <div className="evolve-finetune-gates">
          <Gate ok={!!status?.datasets_ready} label={status ? `训练数据就绪(训练 ${status.train_rows}/${status.min_train_rows} · 测试 ${status.test_rows})` : "训练数据"} />
          <Gate ok={!!status?.local_active} label={status?.local_active ? `使用本地模型对话(${status.current_model})` : "使用本地模型对话"} />
        </div>

        {status && (
          <div className="evolve-form-hint evolve-finetune-backend">
            后端:{status.backend_reason}{status.mode === "scaffold" ? " · 未配置 MinT key,当前为脚手架(只打印将执行的命令)。" : ""}
          </div>
        )}

        {!status?.can_start && (
          <button type="button" onClick={onGoSettings} className="evolve-link-button evolve-finetune-settings-link">
            去设置配置数据集 / 启用本地模型 →
          </button>
        )}

        {status?.can_start && (
          <div className="evolve-finetune-controls">
            <label className="evolve-field evolve-field--inline">
              步数 · {steps}
              <input type="range" min={1} max={100} value={steps} onChange={(e) => setSteps(Number(e.target.value))} className="evolve-range evolve-range--compact" />
            </label>
            <button type="button" onClick={start} disabled={busy} className="evolve-primary-button">
              {busy ? "启动中…" : "开始微调 →"}
            </button>
          </div>
        )}

        {/* runs */}
        <RequestNotice loading={loading.runs} error={errors.runs} label="微调记录" />
        {!loading.runs && !errors.runs && runs.length === 0 && (
          <div className="evolve-empty-copy evolve-finetune-empty">还没有微调记录。满足训练门槛后，可从这里开始。</div>
        )}
        {runs.length > 0 && (
          <div className="evolve-record-list evolve-finetune-records">
            <div className="evolve-record-list__label">微调记录</div>
            {runs.slice(0, 8).map((r) => (
              <div
                key={r.id}
                className="evolve-record-row evolve-record-row--compact"
                style={{ "--status-color": SCOLOR[r.status] ?? "var(--ink-3)" } as React.CSSProperties}
              >
                <span className={`evolve-record-dot${r.status === "running" ? " is-running" : ""}`} />
                <span className="evolve-record-name">{r.method.toUpperCase()} · {r.steps} 步{r.scaffold ? " · 脚手架" : ""}</span>
                <span className="evolve-record-status">{SLABEL[r.status] ?? r.status}</span>
                <button type="button" onClick={() => openLog(r)} className="evolve-mini-button">日志</button>
                <span className="evolve-record-time">{fmt(r.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Log modal */}
      {logRun && (
        <DialogShell
          title="微调日志"
          onClose={() => setLogRun(null)}
          className="evolve-dialog--log"
          footer={(
            <>
              {(runs.find((r) => r.id === logRun.id)?.status ?? logRun.status) === "running" && (
                <span role="status" className="evolve-live-status">● 实时刷新中</span>
              )}
              <button type="button" onClick={() => openLog(logRun)} className="evolve-secondary-button">刷新</button>
            </>
          )}
        >
            <div ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }} className="evolve-log-scroll">
              <pre className="evolve-log-output">{logText}</pre>
            </div>
        </DialogShell>
      )}
    </div>
  );
}
