import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppSelector } from "../../store/hooks";
import { moPortOf } from "../../store/slices/gatewaySlice";
import {
  getEvolutionStats,
  getEvolveSchedule,
  getEvolveStatus,
  labelTrajectory,
  listEvolveRuns,
  listPending,
  listTrajectories,
  scheduleMolting,
  type EvolutionStats,
  type EvolveRun,
  type EvolveSchedule,
  type EvolveStatus,
  type PendingList,
  type Trajectory,
} from "../../services/mo-api";
import { useAppState, type EvolveSection } from "../appState";
import { EmptyState, MetricCard, PageHeader, Panel, SectionTabs, StatusBadge } from "../components/EvolveUi";
import { GrowthRings } from "../components/GrowthRings";
import { TapeCard } from "../components/TapeCard";
import { HarnessCurate } from "./HarnessCurate";
import { HarnessEvolve } from "./HarnessEvolve";
import { HarnessInbox } from "./HarnessInbox";
import { HarnessLearn } from "./HarnessLearn";
import { HarnessLedger } from "./HarnessLedger";

const NUMS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
const numCn = (n: number) => (n <= 12 ? NUMS[n] : String(n));

const SECTION_ORDER: EvolveSection[] = ["overview", "reviews", "learn", "skills", "curation", "ledger"];

type OverviewSnapshot = {
  loading: boolean;
  loaded: boolean;
  errors: string[];
  stats: EvolutionStats | null;
  trajectories: Trajectory[];
  pending: PendingList | null;
  evolveStatus: EvolveStatus | null;
  runs: EvolveRun[];
  schedule: EvolveSchedule | null;
};

type ActionTone = "neutral" | "success" | "warning" | "danger" | "info";

type ActionItem = {
  key: string;
  tone: ActionTone;
  title: string;
  detail: string;
  section?: EvolveSection;
  action?: string;
};

const EMPTY_OVERVIEW: OverviewSnapshot = {
  loading: true,
  loaded: false,
  errors: [],
  stats: null,
  trajectories: [],
  pending: null,
  evolveStatus: null,
  runs: [],
  schedule: null,
};

function fmtTime(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function runLabel(status: EvolveRun["status"]): string {
  return {
    running: "运行中",
    done: "待审",
    failed: "失败",
    accepted: "已采纳",
    rejected: "已弃用",
  }[status];
}

function runTone(status: EvolveRun["status"]): ActionTone {
  if (status === "accepted") return "success";
  if (status === "failed") return "danger";
  if (status === "running" || status === "done") return "warning";
  return "neutral";
}

export function EvolveScreen({ mainRef }: { mainRef: React.RefObject<HTMLDivElement | null> }) {
  const moPort = useAppSelector((s) => moPortOf(s.gateway.state));
  const { evolveSection, setEvolveSection, goEvolve, go } = useAppState();
  const [visited, setVisited] = useState<Set<EvolveSection>>(
    () => new Set<EvolveSection>(["overview", evolveSection]),
  );
  const [overview, setOverview] = useState<OverviewSnapshot>(EMPTY_OVERVIEW);
  const [trajOpen, setTrajOpen] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const refreshSeq = useRef(0);

  const refreshOverview = useCallback(async () => {
    const seq = ++refreshSeq.current;
    if (!moPort) {
      setOverview({
        ...EMPTY_OVERVIEW,
        loading: false,
        loaded: true,
        errors: ["本机进化服务尚未连接"],
      });
      return;
    }

    setOverview((current) => ({ ...current, loading: true, errors: [] }));
    const [statsResult, trajResult, pendingResult, statusResult, runsResult, scheduleResult] =
      await Promise.allSettled([
        getEvolutionStats(moPort),
        listTrajectories(moPort, 20),
        listPending(moPort),
        getEvolveStatus(moPort),
        listEvolveRuns(moPort),
        getEvolveSchedule(moPort),
      ]);

    if (seq !== refreshSeq.current) return;

    const errors: string[] = [];
    if (statsResult.status === "rejected") errors.push("成长统计");
    if (trajResult.status === "rejected") errors.push("训练标本");
    if (pendingResult.status === "rejected") errors.push("待确认事项");
    if (statusResult.status === "rejected") errors.push("进化引擎");
    if (runsResult.status === "rejected") errors.push("进化记录");
    if (scheduleResult.status === "rejected") errors.push("夜间计划");

    setOverview({
      loading: false,
      loaded: true,
      errors,
      stats: statsResult.status === "fulfilled" ? statsResult.value : null,
      trajectories: trajResult.status === "fulfilled" ? trajResult.value.data : [],
      pending: pendingResult.status === "fulfilled" ? pendingResult.value : null,
      evolveStatus: statusResult.status === "fulfilled" ? statusResult.value : null,
      runs: runsResult.status === "fulfilled" ? runsResult.value.data : [],
      schedule: scheduleResult.status === "fulfilled" ? scheduleResult.value : null,
    });
  }, [moPort]);

  useEffect(() => {
    setVisited((current) => {
      if (current.has(evolveSection)) return current;
      const next = new Set(current);
      next.add(evolveSection);
      return next;
    });
    mainRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [evolveSection, mainRef]);

  // The page header and tab badges are global to every workbench. Refresh on
  // each section activation so direct links (for example Skills → GEPA) never
  // render an empty overview snapshot, and actions completed in a child
  // workbench are reflected when the user moves on.
  useEffect(() => {
    void refreshOverview();
  }, [evolveSection, refreshOverview]);

  // Only the visible overview polls, and only while a run is actually moving.
  // Once the run settles this effect tears itself down on the next refresh.
  useEffect(() => {
    if (evolveSection !== "overview" || !moPort) return;
    if (!overview.runs.some((run) => run.status === "running")) return;
    const timer = window.setInterval(() => void refreshOverview(), 4000);
    return () => window.clearInterval(timer);
  }, [evolveSection, moPort, overview.runs, refreshOverview]);

  const pendingCount = overview.pending?.data.length ?? 0;
  const runningCount = overview.runs.filter((run) => run.status === "running").length;
  const reviewableCount = overview.runs.filter((run) => run.status === "done").length;
  const acceptedCount = overview.runs.filter((run) => run.status === "accepted").length;
  const failedCount = overview.runs.filter((run) => run.status === "failed").length;
  const pendingRestartCount = overview.evolveStatus?.pending?.length ?? 0;
  const ringCount = overview.stats?.molting_count ?? 0;

  const tabs = useMemo(() => [
    { id: "overview", label: "概览" },
    { id: "reviews", label: "待我确认", badge: pendingCount || undefined },
    { id: "learn", label: "教它一手" },
    { id: "skills", label: "技艺进化", badge: (runningCount + reviewableCount) || undefined },
    { id: "curation", label: "技艺清点" },
    { id: "ledger", label: "成效台账" },
  ], [pendingCount, reviewableCount, runningCount]);

  const actions = useMemo<ActionItem[]>(() => {
    const next: ActionItem[] = [];

    if (!moPort) {
      next.push({
        key: "offline",
        tone: "danger",
        title: "进化服务尚未连接",
        detail: "桌面后端仍在启动，或本机服务连接失败。",
      });
    } else {
      if (overview.evolveStatus && !overview.evolveStatus.ready) {
        next.push({
          key: "engine",
          tone: "danger",
          title: "技艺进化引擎未就绪",
          detail: overview.evolveStatus.reason || "请检查模型配置与引擎日志。",
          section: "skills",
          action: "查看配置",
        });
      }
      if (overview.errors.length > 0) {
        next.push({
          key: "partial",
          tone: "warning",
          title: "部分本机台账暂时读不到",
          detail: `未能读取：${overview.errors.join("、")}。已有数据仍可继续查看。`,
        });
      }
    }

    if (pendingCount > 0) {
      next.push({
        key: "pending",
        tone: "warning",
        title: `${pendingCount} 项改动等你确认`,
        detail: "包括后台复盘、学习草稿或技艺清点产生的提案。",
        section: "reviews",
        action: "去确认",
      });
    }

    if (reviewableCount > 0) {
      next.push({
        key: "reviewable",
        tone: "warning",
        title: `${reviewableCount} 次技艺进化已经完成`,
        detail: "候选仍在暂存区，需要查看 Diff 后决定是否采纳。",
        section: "skills",
        action: "查看候选",
      });
    }

    if (failedCount > 0) {
      next.push({
        key: "failed",
        tone: "danger",
        title: `${failedCount} 次进化没有通过`,
        detail: "失败记录不会自动写回；可查看日志、约束和评审意见。",
        section: "skills",
        action: "查看记录",
      });
    }

    if (pendingRestartCount > 0) {
      next.push({
        key: "restart",
        tone: "info",
        title: `${pendingRestartCount} 项已采纳改动等待重启`,
        detail: "为保留提示词缓存，技艺改动会在下次引擎启动时生效。",
        section: "skills",
        action: "查看进化",
      });
    }

    if (next.length === 0 && overview.loaded && !overview.loading) {
      next.push({
        key: "clear",
        tone: "success",
        title: "现在没有需要处理的事项",
        detail: overview.schedule?.enabled
          ? `夜间技艺进化已安排在 ${String(overview.schedule.hour).padStart(2, "0")}:${String(overview.schedule.minute).padStart(2, "0")}。`
          : "可以继续积累真实轨迹，或主动教它一项新技艺。",
        section: overview.schedule?.enabled ? "skills" : "learn",
        action: overview.schedule?.enabled ? "查看计划" : "教它一手",
      });
    }

    return next;
  }, [
    failedCount,
    moPort,
    overview.errors,
    overview.evolveStatus,
    overview.loaded,
    overview.loading,
    overview.schedule,
    pendingCount,
    pendingRestartCount,
    reviewableCount,
  ]);

  const label = (id: string, nextLabel: "pos" | "neg") => {
    if (!moPort) return;
    setOverview((current) => ({
      ...current,
      trajectories: current.trajectories.map((trajectory) =>
        trajectory.id === id ? { ...trajectory, label: nextLabel } : trajectory),
    }));
    labelTrajectory(moPort, id, nextLabel)
      .then(() => refreshOverview())
      .catch(() => refreshOverview());
  };

  const recordGrowth = () => {
    if (!moPort || recording || recorded) return;
    setRecordError(null);
    setRecording(true);
    scheduleMolting(moPort, `手动记录成长节点 · ${overview.trajectories.length} 条近期轨迹`)
      .then(() => {
        setRecorded(true);
        return refreshOverview();
      })
      .catch(() => {
        setRecordError("成长节点没有写入本机台账，请检查连接后重试。");
      })
      .finally(() => setRecording(false));
  };

  const selectSection = (section: string) => {
    if (SECTION_ORDER.includes(section as EvolveSection)) {
      setEvolveSection(section as EvolveSection);
    }
  };

  const engineAside = overview.evolveStatus ? (
    <StatusBadge tone={overview.evolveStatus.ready ? "success" : "warning"}>
      {overview.evolveStatus.ready ? "进化引擎已就绪" : "进化引擎未就绪"}
    </StatusBadge>
  ) : undefined;

  return (
    <main className="evolve-page">
      <PageHeader
        eyebrow="SELF-EVOLUTION · 自进化中心"
        title={ringCount > 0 ? `第${numCn(ringCount)}环。先看今天需要你做什么。` : "一切从第一条真实轨迹开始。"}
        description="改动先经过你，技艺与模型分开进化；每一次采纳、回退和花费，都留在本机台账里。"
        aside={engineAside}
      />

      <div className="evolve-tabs-wrap">
        <SectionTabs
          ariaLabel="自进化工作台"
          tabs={tabs}
          active={evolveSection}
          onChange={selectSection}
        />
      </div>

      <section
        id="evolve-panel-overview"
        role="tabpanel"
        aria-labelledby="evolve-tab-overview"
        hidden={evolveSection !== "overview"}
        className="evolve-section"
      >
        {overview.loading && !overview.loaded ? (
          <Panel>
            <EmptyState title="正在清点本机成长记录…" description="统计、待确认事项和进化记录会分别读取。" />
          </Panel>
        ) : (
          <Overview
            overview={overview}
            actions={actions}
            ringCount={ringCount}
            pendingCount={pendingCount}
            runningCount={runningCount}
            acceptedCount={acceptedCount}
            trajOpen={trajOpen}
            recorded={recorded}
            recording={recording}
            recordError={recordError}
            onToggleTrajectories={() => setTrajOpen((open) => !open)}
            onLabel={label}
            onRecordGrowth={recordGrowth}
            onRefresh={refreshOverview}
            onGoSection={goEvolve}
            onGoDream={() => go("dream")}
          />
        )}
      </section>

      {(visited.has("reviews") || evolveSection === "reviews") && (
        <section
          id="evolve-panel-reviews"
          role="tabpanel"
          aria-labelledby="evolve-tab-reviews"
          hidden={evolveSection !== "reviews"}
          className="evolve-section"
        >
          <HarnessInbox active={evolveSection === "reviews"} />
        </section>
      )}

      {(visited.has("learn") || evolveSection === "learn") && (
        <section
          id="evolve-panel-learn"
          role="tabpanel"
          aria-labelledby="evolve-tab-learn"
          hidden={evolveSection !== "learn"}
          className="evolve-section"
        >
          <HarnessLearn active={evolveSection === "learn"} />
        </section>
      )}

      {(visited.has("skills") || evolveSection === "skills") && (
        <section
          id="evolve-panel-skills"
          role="tabpanel"
          aria-labelledby="evolve-tab-skills"
          hidden={evolveSection !== "skills"}
          className="evolve-section"
        >
          <HarnessEvolve active={evolveSection === "skills"} />
        </section>
      )}

      {(visited.has("curation") || evolveSection === "curation") && (
        <section
          id="evolve-panel-curation"
          role="tabpanel"
          aria-labelledby="evolve-tab-curation"
          hidden={evolveSection !== "curation"}
          className="evolve-section"
        >
          <HarnessCurate active={evolveSection === "curation"} />
        </section>
      )}

      {(visited.has("ledger") || evolveSection === "ledger") && (
        <section
          id="evolve-panel-ledger"
          role="tabpanel"
          aria-labelledby="evolve-tab-ledger"
          hidden={evolveSection !== "ledger"}
          className="evolve-section"
        >
          <HarnessLedger active={evolveSection === "ledger"} />
        </section>
      )}
    </main>
  );
}

type OverviewProps = {
  overview: OverviewSnapshot;
  actions: ActionItem[];
  ringCount: number;
  pendingCount: number;
  runningCount: number;
  acceptedCount: number;
  trajOpen: boolean;
  recorded: boolean;
  recording: boolean;
  recordError: string | null;
  onToggleTrajectories: () => void;
  onLabel: (id: string, label: "pos" | "neg") => void;
  onRecordGrowth: () => void;
  onRefresh: () => void;
  onGoSection: (section: EvolveSection) => void;
  onGoDream: () => void;
};

function Overview({
  overview,
  actions,
  ringCount,
  pendingCount,
  runningCount,
  acceptedCount,
  trajOpen,
  recorded,
  recording,
  recordError,
  onToggleTrajectories,
  onLabel,
  onRecordGrowth,
  onRefresh,
  onGoSection,
  onGoDream,
}: OverviewProps) {
  const recentRuns = overview.runs.slice(0, 5);

  return (
    <div className="evolve-overview">
      <div className="evolve-metrics" aria-label="自进化关键指标">
        <MetricCard label="待我确认" value={pendingCount} hint="后台提案与学习草稿" tone={pendingCount > 0 ? "warning" : "neutral"} />
        <MetricCard label="运行中" value={runningCount} hint="技艺 GEPA 任务" tone={runningCount > 0 ? "info" : "neutral"} />
        <MetricCard label="已采纳" value={acceptedCount} hint="保留在进化记录中" tone={acceptedCount > 0 ? "success" : "neutral"} />
        <MetricCard label="轨迹标本" value={overview.stats?.task_count ?? "—"} hint="本机真实对话记录" tone="neutral" />
      </div>

      <div className="evolve-overview-grid">
        <div className="evolve-overview-main">
          <Panel title="现在需要你" eyebrow="ACTION INBOX">
            <div className="evolve-action-list">
              {actions.map((item) => (
                <div key={item.key} className={`evolve-action-item evolve-action-item--${item.tone}`}>
                  <span className="evolve-action-dot" aria-hidden="true" />
                  <div className="evolve-action-copy">
                    <div className="evolve-action-title">{item.title}</div>
                    <div className="evolve-action-detail">{item.detail}</div>
                  </div>
                  {item.section && item.action && (
                    <button type="button" className="evolve-link-button" onClick={() => onGoSection(item.section!)}>
                      {item.action} →
                    </button>
                  )}
                </div>
              ))}
            </div>
            {overview.errors.length > 0 && (
              <button type="button" className="evolve-secondary-button" onClick={onRefresh}>
                重新读取缺失台账
              </button>
            )}
          </Panel>

          <Panel title="最近的技艺进化" eyebrow="RECENT RUNS">
            {recentRuns.length === 0 ? (
              <EmptyState
                title="还没有技艺进化记录"
                description="先积累真实轨迹，再挑一项技艺让夜貘打磨。"
                action={<button type="button" className="evolve-link-button" onClick={() => onGoSection("skills")}>去技艺进化 →</button>}
              />
            ) : (
              <div className="evolve-run-list">
                {recentRuns.map((run) => (
                  <button key={run.id} type="button" className="evolve-run-row" onClick={() => onGoSection("skills")}>
                    <span className="evolve-run-skill">{run.skill}</span>
                    <StatusBadge tone={runTone(run.status)}>{runLabel(run.status)}</StatusBadge>
                    <span className="evolve-run-time">{fmtTime(run.created_at)}</span>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <TapeCard tapeLeft={true} tapeRotate="-2.5deg" style={{ padding: "24px 22px 20px" }}>
          <div className="evolve-growth-card">
            <GrowthRings count={Math.max(ringCount, 1)} />
            <div className="evolve-growth-kicker">GROWTH RINGS · 生长环</div>
            <div className="evolve-growth-count">已经留下 {ringCount} 个成长节点</div>
            <p>生长环只记录被你确认过的成长，不把一次运行伪装成真正进步。</p>
          </div>
        </TapeCard>
      </div>

      <div className="evolve-panel-grid">
        <Panel
          title="训练标本"
          eyebrow="TRAJECTORIES"
          actions={(
            <button type="button" className="evolve-secondary-button" onClick={onToggleTrajectories}>
              {trajOpen ? "收起" : "查看最近 20 条"}
            </button>
          )}
        >
          <div className="evolve-ledger-summary">
            <span>正例 <b>{overview.stats?.labeled_pos ?? 0}</b></span>
            <span>负例 <b>{overview.stats?.labeled_neg ?? 0}</b></span>
            <span>标注成功率 <b>{overview.stats?.success_rate == null ? "—" : `${Math.round(overview.stats.success_rate * 100)}%`}</b></span>
          </div>
          <p className="evolve-panel-note">标本仅保存在本机。正负标注会进入后续真实轨迹评测。</p>
          {trajOpen && (
            <div className="evolve-trajectory-list">
              {overview.trajectories.length === 0 ? (
                <EmptyState title="还没有训练标本" description="去工作台完成一次对话后，这里会出现真实轨迹。" />
              ) : overview.trajectories.map((trajectory) => (
                <div key={trajectory.id} className="evolve-trajectory-row">
                  <div className="evolve-trajectory-copy">
                    <span className="evolve-trajectory-prompt">{trajectory.prompt}</span>
                    <span className="evolve-trajectory-time">{fmtTime(trajectory.created_at)}</span>
                  </div>
                  <div className="evolve-inline-actions">
                    <button
                      type="button"
                      aria-pressed={trajectory.label === "pos"}
                      className={`evolve-stamp-button evolve-stamp-button--positive${trajectory.label === "pos" ? " is-active" : ""}`}
                      onClick={() => onLabel(trajectory.id, "pos")}
                    >
                      正
                    </button>
                    <button
                      type="button"
                      aria-pressed={trajectory.label === "neg"}
                      className={`evolve-stamp-button evolve-stamp-button--negative${trajectory.label === "neg" ? " is-active" : ""}`}
                      onClick={() => onLabel(trajectory.id, "neg")}
                    >
                      负
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="成长记录"
          eyebrow="MILESTONES"
          actions={(
            <StatusBadge tone={overview.schedule?.enabled ? "success" : "neutral"}>
              {overview.schedule?.enabled
                ? `夜间计划 ${String(overview.schedule.hour).padStart(2, "0")}:${String(overview.schedule.minute).padStart(2, "0")}`
                : "夜间计划未开启"}
            </StatusBadge>
          )}
        >
          <div className="evolve-milestone">
            <div>
              <span className="evolve-milestone-label">最近一次成长节点</span>
              <strong>{overview.stats?.last_molting ? fmtTime(overview.stats.last_molting.at) : "还没有记录"}</strong>
            </div>
            {overview.stats?.last_molting?.note && <p>{overview.stats.last_molting.note}</p>}
          </div>
          <p className="evolve-panel-note">
            “记录成长节点”只写入本机成长台账，不会启动 GEPA、LoRA 或 GRPO 训练。
          </p>
          <div className="evolve-inline-actions">
            <button
              type="button"
              className="evolve-primary-button"
              disabled={recording || recorded}
              onClick={onRecordGrowth}
            >
              {recording ? "记录中…" : recorded ? "已记入成长台账 ✓" : "记录成长节点"}
            </button>
            <button type="button" className="evolve-link-button" onClick={onGoDream}>去看梦境 →</button>
          </div>
          {recordError && <div className="evolve-inline-error" role="alert">{recordError}</div>}
        </Panel>
      </div>
    </div>
  );
}
