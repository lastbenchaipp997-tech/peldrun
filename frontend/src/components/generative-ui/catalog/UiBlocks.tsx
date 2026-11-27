// frontend/src/components/generative-ui/catalog/UiBlocks.tsx
//
// v5 renderers: UiAlert and UiKpi. Imported by PeldrunCardBlock.tsx.
// No store access, no runtime context: pure presentation of a payload that
// cards.ts has already sanitized.
//
// Tailwind: every class below is a complete literal string (never built
// dynamically) so the JIT compiler ships it.

"use client";

import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Minus,
  TrendingDown,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import type {
  AlertPayload,
  AlertTone,
  KpiItem,
  KpiPayload,
  KpiSentiment,
} from "./cardBlocks";

const join = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

const ALERT_STYLES: Record<AlertTone, { box: string; icon: string; Icon: LucideIcon }> = {
  info: {
    box: "border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-800/60 dark:bg-sky-950/30 dark:text-sky-100",
    icon: "text-sky-600 dark:text-sky-400",
    Icon: Info,
  },
  success: {
    box: "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-100",
    icon: "text-emerald-600 dark:text-emerald-400",
    Icon: CheckCircle2,
  },
  warning: {
    box: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100",
    icon: "text-amber-600 dark:text-amber-400",
    Icon: AlertTriangle,
  },
  error: {
    box: "border-red-200 bg-red-50 text-red-950 dark:border-red-800/60 dark:bg-red-950/30 dark:text-red-100",
    icon: "text-red-600 dark:text-red-400",
    Icon: XCircle,
  },
};

export function UiAlert({ alert }: { alert: AlertPayload }): React.JSX.Element {
  const s = ALERT_STYLES[alert.tone];
  const Icon = s.Icon;
  return (
    <div
      dir="auto"
      role={alert.tone === "warning" || alert.tone === "error" ? "alert" : "status"}
      className={join("my-3 flex gap-2.5 rounded-xl border p-3.5 text-start", s.box)}
    >
      <Icon size={18} aria-hidden="true" className={join("mt-0.5 shrink-0", s.icon)} />
      <div className="min-w-0 space-y-1">
        {alert.title && (
          <div className="text-sm font-semibold leading-snug">{alert.title}</div>
        )}
        {alert.text && (
          <p className="text-xs leading-relaxed opacity-90 sm:text-[13px]">{alert.text}</p>
        )}
        {alert.items.length > 0 && (
          <ul className="list-disc space-y-0.5 ps-4 text-xs opacity-90 sm:text-[13px]">
            {alert.items.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

const KPI_COLS: Record<KpiPayload["columns"], string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
};

const SENTIMENT_CLASS: Record<KpiSentiment, string> = {
  positive: "text-emerald-600 dark:text-emerald-400",
  negative: "text-red-600 dark:text-red-400",
  neutral: "text-muted-foreground",
};

function Sparkline({ values, className }: { values: number[]; className: string }) {
  const w = 100;
  const h = 28;
  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={className}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function KpiTile({ item }: { item: KpiItem }): React.JSX.Element {
  const tone = SENTIMENT_CLASS[item.sentiment];
  const TrendIcon =
    item.trend === "up" ? TrendingUp : item.trend === "down" ? TrendingDown : Minus;

  return (
    <div
      dir="auto"
      className="flex min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-muted/40 p-3.5 text-start"
    >
      <div className="truncate text-xs text-muted-foreground">{item.label}</div>

      <div className="flex items-baseline gap-1">
        <span className="truncate text-xl font-semibold tabular-nums leading-tight sm:text-2xl">
          {item.value}
        </span>
        {item.unit && (
          <span className="shrink-0 text-xs text-muted-foreground">{item.unit}</span>
        )}
      </div>

      {(item.delta || item.trend) && (
        <div className={join("flex items-center gap-1 text-xs font-medium", tone)}>
          <TrendIcon size={13} aria-hidden="true" className="shrink-0" />
          {item.delta && <span className="tabular-nums">{item.delta}</span>}
        </div>
      )}

      {item.spark && (
        // Charts never mirror in RTL: time always runs left to right.
        <div dir="ltr" className={join("mt-1 h-7 w-full", tone)}>
          <Sparkline values={item.spark} className="h-full w-full" />
        </div>
      )}
    </div>
  );
}

export function UiKpi({ kpi }: { kpi: KpiPayload }): React.JSX.Element {
  return (
    <div className="my-3 space-y-2">
      {kpi.title && (
        <h3 dir="auto" className="text-sm font-semibold text-foreground">
          {kpi.title}
        </h3>
      )}
      <div className={join("grid gap-2.5", KPI_COLS[kpi.columns])}>
        {kpi.items.map((item, i) => (
          <KpiTile key={i} item={item} />
        ))}
      </div>
      {kpi.hidden > 0 && (
        <div className="text-xs text-muted-foreground">+{kpi.hidden}</div>
      )}
    </div>
  );
}
