// frontend/src/components/generative-ui/catalog/cards.ts
//
// Types, constants, and the tolerant parser for ```ui fenced blocks.
// Pure TypeScript: no React, no store access, so it is trivially unit-testable.
//
// Wire format (what the model writes):
//   { "type": "card", "layout": "media-start", "title": "...", ... }
//   { "type": "grid", "columns": 2, "items": [ <card>, <card> ] }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CARD_LAYOUTS = [
  "vertical",
  "media-start",
  "media-end",
  "overlay",
  "tile",
  "compact",
] as const;
export type CardLayout = (typeof CARD_LAYOUTS)[number];

/**
 * v4: optional pastel accent. Keys mirror the Tailwind palette so any
 * combination reads consistently. Adding a key here REQUIRES adding a
 * matching entry to `ACCENT_CLASSES` in PeldrunCardBlock.tsx — a key
 * without a style entry falls back silently to the default card
 * background.
 */
export const CARD_ACCENTS = [
  "blue", "sky", "cyan", "teal", "emerald", "green", "lime", "amber",
  "yellow", "orange", "red", "rose", "pink", "fuchsia", "purple", "violet",
  "indigo", "slate",
] as const;
export type CardAccent = (typeof CARD_ACCENTS)[number];

/**
 * v4.2: how the accent is applied.
 *   tinted   -> soft gradient background + colored border (default)
 *   outlined -> 2px colored border, transparent fill
 *   minimal  -> very light tint + thin border
 *
 * Stored per-card so a flow can mix a "tinted" hero with "outlined"
 * secondary items, and a grid can keep dense category tiles at
 * "minimal" without saturating the eye.
 */
export const CARD_ACCENT_STYLES = ["tinted", "outlined", "minimal"] as const;
export type CardAccentStyle = (typeof CARD_ACCENT_STYLES)[number];

/**
 * v4.2: tag entry. Two shapes are accepted:
 *   - string             -> inherits the card's accent; falls back to
 *                           muted gray when the card has no accent.
 *   - { label, accent? } -> explicit per-tag color override.
 *
 * A tag's `style` is intentionally NOT configurable: tags are always
 * rendered with a light pill variant so they never compete visually
 * with the card body.
 */
export type CardTag =
  | string
  | { label: string; accent?: CardAccent };

/** Whitelist: the model can only pick icons from this list. */
export const CARD_ICON_KEYS = [
  "map", "route", "pin", "chart-line", "chart-bar", "chart-pie", "flow",
  "grid", "table", "calendar", "activity", "document", "info", "star",
  "users", "clock", "globe", "package", "idea",
] as const;
export type CardIconKey = (typeof CARD_ICON_KEYS)[number];

// ---------------------------------------------------------------------------
// Payload types (post-normalization)
// ---------------------------------------------------------------------------

export interface CardImageSpec {
  /** Opaque id resolved by the host (attachment id, tool-result id...). */
  ref?: string;
  /** Direct https URL. Only honored when the runtime allows remote URLs. */
  url?: string;
  /** Image-search phrase; the backend resolves it after generation. */
  query?: string;
  alt: string;
  fit: "cover" | "contain";
}

export interface CardStat { label: string; value: string }

export interface CardAction {
  label: string;
  /** Sent as a new user message when clicked. */
  prompt?: string;
  /** External https link. */
  href?: string;
}

export interface CardPayload {
  type: "card";
  layout: CardLayout;
  title: string;
  subtitle?: string;
  description?: string;
  icon?: CardIconKey;
  image?: CardImageSpec;
  href?: string;
  /** v4: optional soft gradient tint (see CARD_ACCENTS). */
  accent?: CardAccent;
  /** v4.2: optional shading style; defaults to "tinted". */
  style?: CardAccentStyle;
  /** v4.2: each tag can be a plain string or a colored object. */
  tags: CardTag[];
  stats: CardStat[];
  actions: CardAction[];
}

export interface GridPayload {
  type: "grid";
  columns: 1 | 2 | 3 | 4;
  title?: string;
  items: CardPayload[];
  /** Number of valid items dropped because of the max_cards limit. */
  hidden: number;
}

/**
 * v4: sequential / layered explanation. Items render as their own
 * cards connected by arrows — vertical (stacked) or horizontal (row).
 * Used for step-by-step processes, layered architectures, or concept
 * maps where 3+ stages must be read in order.
 *
 * Flow items reuse `CardPayload` entirely; the renderer simply omits
 * `stats` and `actions` because the flow layout has no room for them.
 * Sharing the type keeps the parser and sanitizer identical to the
 * card path — any future safety check added to `normalizeCard`
 * applies to both shapes automatically.
 */
export interface FlowPayload {
  type: "flow";
  direction: "vertical" | "horizontal";
  title?: string;
  items: CardPayload[];
  /** Number of valid items dropped because of the max_cards limit. */
  hidden: number;
}

// ---------------------------------------------------------------------------
// Interactive form (v4.2)
// ---------------------------------------------------------------------------

/** Hard cap shared with the backend prompt builder. */
export const MAX_FORM_QUESTIONS = 6;
export const MAX_FORM_OPTIONS = 8;

export interface FormOption {
  /** Stable identifier used by the submit template (`{{qid}}`). */
  id: string;
  label: string;
}

export interface FormQuestion {
  /** Stable identifier used by the submit template (`{{qid}}`). */
  id: string;
  label: string;
  description?: string;
  /** `single` = radio buttons, `multi` = checkboxes. */
  type: "single" | "multi";
  required: boolean;
  options: FormOption[];
}

/**
 * v4.2: an interactive question card.
 *
 * Renders a static list of radio/checkbox questions with a submit
 * button. On submit, the selected labels are substituted into
 * `submitPrompt` (or a plain list is emitted when `submitPrompt` is
 * missing) and dispatched through `CardRuntimeContext.sendPrompt`.
 *
 * The form is stateful ONLY within the rendered component instance.
 * Submitting twice without a remount is prevented by a local
 * `submitted` flag; the state naturally resets on refresh, which is
 * acceptable because the user's next message is what carries the
 * selections forward, not the widget itself.
 */
export interface FormPayload {
  type: "form";
  title?: string;
  description?: string;
  accent?: CardAccent;
  style?: CardAccentStyle;
  questions: FormQuestion[];
  submitLabel: string;
  submitPrompt?: string;
}

export type UiPayload =
  | CardPayload
  | GridPayload
  | FlowPayload
  | FormPayload;

export type UiParseResult =
  | { ok: true; payload: UiPayload }
  | { ok: false; reason: string; incomplete: boolean };

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

function text(value: unknown, max: number): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return undefined;
  const t = value.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

/** https only. Blocks javascript:, data:, http:, relative paths. */
export function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const REF_RE = /^[\w-]{1,64}$/;

/**
 * Normalize a single tag entry. Accepts both the legacy string shape and
 * the v4.2 `{ label, accent? }` shape. Returns null for anything that
 * cannot be reduced to a non-empty label.
 */
function normalizeTag(raw: unknown): CardTag | null {
  if (typeof raw === "string") {
    const t = text(raw, 24);
    return t || null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const label = text(o.label, 24);
    if (!label) return null;
    const accentRaw = typeof o.accent === "string" ? o.accent.toLowerCase() : "";
    const accent = (CARD_ACCENTS as readonly string[]).includes(accentRaw)
      ? (accentRaw as CardAccent)
      : undefined;
    return { label, accent };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Streaming detection
// ---------------------------------------------------------------------------

/**
 * True when the source looks like JSON that is still being streamed
 * (unbalanced braces/brackets or an open string). The renderer shows a
 * skeleton instead of an error box for these.
 */
export function isIncompleteJson(source: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  for (const ch of source) {
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") { depth += 1; started = true; }
    else if (ch === "}" || ch === "]") depth -= 1;
  }
  return !started || depth > 0 || inString;
}

// ---------------------------------------------------------------------------
// Tolerant JSON parsing (mirrors the chart block's retry ladder)
// ---------------------------------------------------------------------------

function buildAttempts(source: string, maxRetries: number): string[] {
  const out: string[] = [source.trim()];
  const stripped = source.replace(/```(?:json)?/gi, "").trim();
  if (maxRetries >= 1) {
    out.push(stripped);
    const i = stripped.indexOf("{");
    const j = stripped.lastIndexOf("}");
    if (i >= 0 && j > i) out.push(stripped.slice(i, j + 1));
  }
  if (maxRetries >= 2) {
    const base = [...out];
    for (const s of base) out.push(s.replace(/,(\s*[}\]])/g, "$1"));
  }
  return Array.from(new Set(out.filter(Boolean)));
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeCard(raw: unknown): CardPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const title = text(o.title, 80);
  if (!title) return null;

  const layoutRaw = String(o.layout ?? "vertical").toLowerCase();
  const layout = (CARD_LAYOUTS as readonly string[]).includes(layoutRaw)
    ? (layoutRaw as CardLayout)
    : "vertical";

  const iconRaw = typeof o.icon === "string" ? o.icon.toLowerCase() : "";
  const icon = (CARD_ICON_KEYS as readonly string[]).includes(iconRaw)
    ? (iconRaw as CardIconKey)
    : undefined;

  const accentRaw = typeof o.accent === "string" ? o.accent.toLowerCase() : "";
  const accent = (CARD_ACCENTS as readonly string[]).includes(accentRaw)
    ? (accentRaw as CardAccent)
    : undefined;

  const styleRaw = typeof o.style === "string" ? o.style.toLowerCase() : "";
  const style = (CARD_ACCENT_STYLES as readonly string[]).includes(styleRaw)
    ? (styleRaw as CardAccentStyle)
    : undefined;

  let image: CardImageSpec | undefined;
  if (o.image && typeof o.image === "object") {
    const im = o.image as Record<string, unknown>;
    const ref =
      typeof im.ref === "string" && REF_RE.test(im.ref) ? im.ref : undefined;
    const url = safeHttpsUrl(im.url);
    const query = text(im.query, 100);
    if (ref || url || query) {
      image = {
        ref,
        url,
        query,
        alt: text(im.alt, 160) ?? title,
        fit: im.fit === "contain" ? "contain" : "cover",
      };
    }
  }

  const tags: CardTag[] = (Array.isArray(o.tags) ? o.tags : [])
    .map(normalizeTag)
    .filter((t): t is CardTag => t !== null)
    .slice(0, 6);

  const stats: CardStat[] = [];
  if (Array.isArray(o.stats)) {
    for (const s of o.stats.slice(0, 4)) {
      const r = (s ?? {}) as Record<string, unknown>;
      const label = text(r.label, 32);
      const value = text(r.value, 48);
      if (label && value) stats.push({ label, value });
    }
  }

  const actions: CardAction[] = [];
  if (Array.isArray(o.actions)) {
    for (const a of o.actions.slice(0, 3)) {
      const r = (a ?? {}) as Record<string, unknown>;
      const label = text(r.label, 40);
      const prompt = text(r.prompt, 300);
      const href = safeHttpsUrl(r.href);
      if (label && (prompt || href)) actions.push({ label, prompt, href });
    }
  }

  return {
    type: "card",
    layout,
    title,
    subtitle: text(o.subtitle, 160),
    description: text(o.description, 400),
    icon,
    accent,
    style,
    image,
    href: safeHttpsUrl(o.href),
    tags,
    stats,
    actions,
  };
}

/**
 * Normalize a single form question. The id is coerced to a safe
 * `[a-zA-Z0-9_]` token so it can be used as a `{{placeholder}}` key
 * without escaping. Options are capped at MAX_FORM_OPTIONS and
 * deduplicated by id.
 *
 * Returns null when the question has no label or no valid options —
 * the caller filters nulls and rejects the whole form when nothing
 * survives.
 */
function normalizeQuestion(raw: unknown, idx: number): FormQuestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const label = text(o.label, 200);
  if (!label) return null;

  const idRaw = text(o.id, 40) || `q${idx}`;
  const id = idRaw.replace(/[^a-zA-Z0-9_]/g, "_");

  const typeRaw = String(o.type ?? "single").toLowerCase();
  const type: "single" | "multi" = typeRaw === "multi" ? "multi" : "single";

  const optionsRaw = Array.isArray(o.options) ? o.options : [];
  const options: FormOption[] = [];
  const seenIds = new Set<string>();
  for (const optRaw of optionsRaw.slice(0, MAX_FORM_OPTIONS)) {
    if (!optRaw || typeof optRaw !== "object" || Array.isArray(optRaw)) continue;
    const oo = optRaw as Record<string, unknown>;
    const optLabel = text(oo.label, 100);
    if (!optLabel) continue;
    const optIdRaw = text(oo.id, 40) || `opt${options.length}`;
    const optId = optIdRaw.replace(/[^a-zA-Z0-9_]/g, "_");
    if (seenIds.has(optId)) continue;
    seenIds.add(optId);
    options.push({ id: optId, label: optLabel });
  }
  if (options.length === 0) return null;

  return {
    id,
    label,
    description: text(o.description, 300),
    type,
    required: o.required === true,
    options,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function parseUiPayload(
  source: string,
  maxCards: number,
  maxRetries = 0,
): UiParseResult {
  if (!source || !source.trim()) {
    return { ok: false, reason: "Empty ui block.", incomplete: true };
  }

  let raw: unknown;
  let parsed = false;
  let lastError = "";
  for (const candidate of buildAttempts(source, maxRetries)) {
    try {
      raw = JSON.parse(candidate);
      parsed = true;
      break;
    } catch (err) {
      lastError = (err as { message?: string })?.message ?? "Invalid JSON.";
    }
  }
  if (!parsed) {
    return {
      ok: false,
      reason: lastError || "Invalid JSON.",
      incomplete: isIncompleteJson(source),
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "ui payload must be a JSON object.", incomplete: false };
  }
  const o = raw as Record<string, unknown>;
  const type = String(o.type ?? "card").toLowerCase();

  if (type === "card") {
    const card = normalizeCard(o);
    return card
      ? { ok: true, payload: card }
      : { ok: false, reason: "Card requires a non-empty `title`.", incomplete: false };
  }

  if (type === "grid" || type === "cards") {
    const rawItems = Array.isArray(o.items)
      ? o.items
      : Array.isArray(o.cards)
        ? o.cards
        : null;
    if (!rawItems || rawItems.length === 0) {
      return { ok: false, reason: "Grid requires a non-empty `items` array.", incomplete: false };
    }
    const valid = rawItems
      .map(normalizeCard)
      .filter((c): c is CardPayload => c !== null);
    if (valid.length === 0) {
      return { ok: false, reason: "No grid item has a valid `title`.", incomplete: false };
    }
    const limit = Math.max(1, maxCards);
    const colsRaw = Math.round(Number(o.columns));
    const columns = (
      Number.isFinite(colsRaw) ? Math.min(4, Math.max(1, colsRaw)) : 2
    ) as 1 | 2 | 3 | 4;
    return {
      ok: true,
      payload: {
        type: "grid",
        columns,
        title: text(o.title, 80),
        items: valid.slice(0, limit),
        hidden: Math.max(0, valid.length - limit),
      },
    };
  }

  if (type === "flow") {
    const rawItems = Array.isArray(o.items) ? o.items : null;
    if (!rawItems || rawItems.length === 0) {
      return {
        ok: false,
        reason: "Flow requires a non-empty `items` array.",
        incomplete: false,
      };
    }
    const valid = rawItems
      .map(normalizeCard)
      .filter((c): c is CardPayload => c !== null);
    if (valid.length === 0) {
      return {
        ok: false,
        reason: "No flow item has a valid `title`.",
        incomplete: false,
      };
    }
    const limit = Math.max(1, maxCards);
    const directionRaw = String(o.direction ?? "vertical").toLowerCase();
    const direction: FlowPayload["direction"] =
      directionRaw === "horizontal" ? "horizontal" : "vertical";
    return {
      ok: true,
      payload: {
        type: "flow",
        direction,
        title: text(o.title, 80),
        items: valid.slice(0, limit),
        hidden: Math.max(0, valid.length - limit),
      },
    };
  }

  if (type === "form") {
    const rawQuestions = Array.isArray(o.questions) ? o.questions : null;
    if (!rawQuestions || rawQuestions.length === 0) {
      return {
        ok: false,
        reason: "Form requires a non-empty `questions` array.",
        incomplete: false,
      };
    }
    const questions = rawQuestions
      .slice(0, MAX_FORM_QUESTIONS)
      .map((q, i) => normalizeQuestion(q, i))
      .filter((q): q is FormQuestion => q !== null);
    if (questions.length === 0) {
      return {
        ok: false,
        reason:
          "No form question has a valid `label` and at least one option.",
        incomplete: false,
      };
    }

    const accentRaw = typeof o.accent === "string" ? o.accent.toLowerCase() : "";
    const accent = (CARD_ACCENTS as readonly string[]).includes(accentRaw)
      ? (accentRaw as CardAccent)
      : undefined;

    const styleRaw = typeof o.style === "string" ? o.style.toLowerCase() : "";
    const style = (CARD_ACCENT_STYLES as readonly string[]).includes(styleRaw)
      ? (styleRaw as CardAccentStyle)
      : undefined;

    return {
      ok: true,
      payload: {
        type: "form",
        title: text(o.title, 80),
        description: text(o.description, 300),
        accent,
        style,
        questions,
        submitLabel: text(o.submitLabel, 40) || "Submit",
        submitPrompt: text(o.submitPrompt, 2000),
      },
    };
  }

  return { ok: false, reason: `Unknown ui type "${type}".`, incomplete: false };
}
