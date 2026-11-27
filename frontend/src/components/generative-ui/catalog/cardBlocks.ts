// frontend/src/components/generative-ui/catalog/cardBlocks.ts
//
// Types + sanitizers for the v5 blocks: `alert` and `kpi`.
// Pure TypeScript (no React, no store). Imported by cards.ts, which owns
// parseUiPayload(). This file must NOT import runtime values from cards.ts
// (that would create an import cycle): anything it needs is passed in.

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

export const ALERT_TONES = ["info", "success", "warning", "error"] as const;
export type AlertTone = (typeof ALERT_TONES)[number];

export interface AlertPayload {
  type: "alert";
  tone: AlertTone;
  title?: string;
  text?: string;
  /** Optional short bullet list (max 5). */
  items: string[];
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------

export type KpiTrend = "up" | "down" | "flat";
export type KpiSentiment = "positive" | "negative" | "neutral";

export interface KpiItem {
  label: string;
  value: string;
  unit?: string;
  /** Display string such as "+12%" (never computed by the renderer). */
  delta?: string;
  trend?: KpiTrend;
  /** Colors the delta. Defaults from trend: up=positive, down=negative. */
  sentiment: KpiSentiment;
  /** 2..24 finite numbers; drawn as a tiny line. */
  spark?: number[];
}

export interface KpiPayload {
  type: "kpi";
  columns: 1 | 2 | 3 | 4;
  title?: string;
  items: KpiItem[];
  /** Valid items dropped because of the max_cards limit. */
  hidden: number;
}

export const MAX_KPI_ITEMS = 8;
export const MAX_SPARK_POINTS = 24;

// ---------------------------------------------------------------------------
// Local sanitizer (same behavior as text() in cards.ts)
// ---------------------------------------------------------------------------

export function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return undefined;
  const t = value.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

// ---------------------------------------------------------------------------
// Alert normalization
// ---------------------------------------------------------------------------

const TONE_ALIASES: Record<string, AlertTone> = {
  info: "info", note: "info", tip: "info", neutral: "info",
  success: "success", ok: "success", good: "success", done: "success",
  warning: "warning", warn: "warning", caution: "warning",
  error: "error", err: "error", danger: "error", critical: "error", fail: "error",
};

export function normalizeAlert(raw: unknown): AlertPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const tone = TONE_ALIASES[String(o.tone ?? o.severity ?? "info").toLowerCase()] ?? "info";
  const title = cleanText(o.title, 80);
  const body = cleanText(o.text ?? o.message ?? o.description, 600);
  const items = (Array.isArray(o.items) ? o.items : [])
    .map((i) => cleanText(i, 160))
    .filter((i): i is string => Boolean(i))
    .slice(0, 5);

  if (!title && !body && items.length === 0) return null;
  return { type: "alert", tone, title, text: body, items };
}

// ---------------------------------------------------------------------------
// KPI normalization
// ---------------------------------------------------------------------------

function inferTrend(delta: string | undefined): KpiTrend | undefined {
  if (!delta) return undefined;
  const c = delta.trim()[0];
  if (c === "+") return "up";
  if (c === "-" || c === "\u2212") return "down"; // hyphen-minus or U+2212
  return undefined;
}

export function normalizeKpiItem(raw: unknown): KpiItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const label = cleanText(o.label ?? o.title, 40);
  const value = cleanText(o.value, 24);
  if (!label || !value) return null;

  const delta = cleanText(o.delta ?? o.change, 16);

  const trendRaw = String(o.trend ?? "").toLowerCase();
  const trend: KpiTrend | undefined =
    trendRaw === "up" || trendRaw === "down" || trendRaw === "flat"
      ? trendRaw
      : inferTrend(delta);

  const sentRaw = String(o.sentiment ?? "").toLowerCase();
  const sentiment: KpiSentiment =
    sentRaw === "positive" || sentRaw === "negative" || sentRaw === "neutral"
      ? sentRaw
      : trend === "up"
        ? "positive"
        : trend === "down"
          ? "negative"
          : "neutral";

  let spark: number[] | undefined;
  if (Array.isArray(o.spark)) {
    const nums = o.spark
      .slice(0, MAX_SPARK_POINTS)
      .map((n) => (typeof n === "string" ? Number(n) : n))
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    if (nums.length >= 2) spark = nums;
  }

  return { label, value, unit: cleanText(o.unit, 12), delta, trend, sentiment, spark };
}
