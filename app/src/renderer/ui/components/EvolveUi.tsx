import React, { useEffect, useId, useRef } from "react";

type CommonProps = {
  className?: string;
};

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export type PageHeaderProps = CommonProps & {
  eyebrow: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;
};

export function PageHeader({ eyebrow, title, description, aside, className }: PageHeaderProps) {
  return (
    <header className={cx("evolve-page-header", className)}>
      <div className="evolve-page-header__copy">
        <div className="evolve-eyebrow">{eyebrow}</div>
        <h1 className="evolve-page-title">{title}</h1>
        {description && <div className="evolve-page-description">{description}</div>}
      </div>
      {aside && <div className="evolve-page-header__aside">{aside}</div>}
    </header>
  );
}

export type SectionTab = {
  id: string;
  label: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
};

export type SectionTabsProps = CommonProps & {
  tabs: SectionTab[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
};

export function SectionTabs({
  tabs,
  active,
  onChange,
  ariaLabel = "自进化页面分区",
  className,
}: SectionTabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const moveTo = (currentId: string, direction: "previous" | "next" | "first" | "last") => {
    const enabled = tabs.filter((tab) => !tab.disabled);
    if (enabled.length === 0) return;

    const current = Math.max(0, enabled.findIndex((tab) => tab.id === currentId));
    let target = current;
    if (direction === "first") target = 0;
    if (direction === "last") target = enabled.length - 1;
    if (direction === "previous") target = (current - 1 + enabled.length) % enabled.length;
    if (direction === "next") target = (current + 1) % enabled.length;

    const next = enabled[target];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    const direction = {
      ArrowLeft: "previous",
      ArrowUp: "previous",
      ArrowRight: "next",
      ArrowDown: "next",
      Home: "first",
      End: "last",
    }[event.key] as "previous" | "next" | "first" | "last" | undefined;

    if (!direction) return;
    event.preventDefault();
    moveTo(id, direction);
  };

  return (
    <div className={cx("evolve-tabs", className)} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[tab.id] = node;
            }}
            type="button"
            role="tab"
            id={`evolve-tab-${tab.id}`}
            aria-controls={`evolve-panel-${tab.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            className="evolve-tab"
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, tab.id)}
          >
            <span>{tab.label}</span>
            {tab.badge != null && <span className="evolve-tab__badge">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

export type PanelProps = CommonProps & {
  title?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
};

export function Panel({ title, eyebrow, actions, className, children }: PanelProps) {
  const titleId = useId();
  const hasHeader = title != null || eyebrow != null || actions != null;

  return (
    <section className={cx("evolve-panel", className)} aria-labelledby={title != null ? titleId : undefined}>
      {hasHeader && (
        <div className="evolve-panel__header">
          <div className="evolve-panel__heading">
            {eyebrow != null && <div className="evolve-panel__eyebrow">{eyebrow}</div>}
            {title != null && <h2 id={titleId} className="evolve-panel__title">{title}</h2>}
          </div>
          {actions != null && <div className="evolve-panel__actions">{actions}</div>}
        </div>
      )}
      <div className="evolve-panel__body">{children}</div>
    </section>
  );
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export type MetricCardProps = CommonProps & {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
};

export function MetricCard({ label, value, hint, tone = "neutral", className }: MetricCardProps) {
  return (
    <div className={cx("evolve-metric-card", `is-${tone}`, className)}>
      <div className="evolve-metric-card__label">{label}</div>
      <div className="evolve-metric-card__value">{value}</div>
      {hint != null && <div className="evolve-metric-card__hint">{hint}</div>}
    </div>
  );
}

export type StatusBadgeProps = CommonProps & {
  tone: Tone;
  children: React.ReactNode;
};

export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
  return (
    <span className={cx("evolve-status-badge", `is-${tone}`, className)}>
      <span className="evolve-status-badge__dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export type EmptyStateProps = CommonProps & {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
};

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cx("evolve-empty-state", className)}>
      <div className="evolve-empty-state__mark" aria-hidden="true">〇</div>
      <div className="evolve-empty-state__title">{title}</div>
      {description != null && <div className="evolve-empty-state__description">{description}</div>}
      {action != null && <div className="evolve-empty-state__action">{action}</div>}
    </div>
  );
}

export type DialogShellProps = CommonProps & {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function DialogShell({ title, onClose, children, footer, className }: DialogShellProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeRef.current?.focus();

    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", onDocumentKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => element.tabIndex >= 0 && !element.hasAttribute("disabled"));
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="evolve-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={cx("evolve-dialog", className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <div className="evolve-dialog__header">
          <h2 id={titleId} className="evolve-dialog__title">{title}</h2>
          <button ref={closeRef} type="button" className="evolve-dialog__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="evolve-dialog__body">{children}</div>
        {footer != null && <div className="evolve-dialog__footer">{footer}</div>}
      </div>
    </div>
  );
}
