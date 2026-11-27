// frontend/src/components/generative-ui/types.ts
//
// Type definitions and constants for the rendering settings system.
//
// These types mirror the backend settings shape defined in
// `backend/peldrun/context/generative_ui.py`. Any change here must be
// reflected in the Python module and vice versa.
//
// The frontend uses these settings to:
//   1. Decide which Markdown renderers to enable (Mermaid, LaTeX, Charts).
//   2. Enforce per-format limits before sending content to heavy renderers.
//   3. Display the current configuration in the settings tab.

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

/**
 * Canonical feature keys.
 *
 * Keep in sync with `DEFAULT_FEATURES` in `generative_ui.py`.
 */
export type RenderingFeatureKey =
  | "mermaid"
  | "latex"
  | "charts"
  | "code_highlighting"
  // v3: UI cards block (```ui fenced JSON) rendered by PeldrunCardBlock.
  | "cards"
  // v3: Permit the model to request images via `image.query` inside
  // cards. Requires `cards` to be on. Enabling this spends the search
  // provider quota for every card-bearing message.
  | "cards_auto_images";

/**
 * Per-feature on/off state.
 *
 * Every key is required so the UI can render a complete toggle list without
 * falling back to undefined values.
 */
export interface RenderingFeatures {
  mermaid: boolean;
  latex: boolean;
  charts: boolean;
  code_highlighting: boolean;

  /**
   * Enable the ```ui fenced block. The backend emits a [UI CARDS]
   * directive only when this is true. Defaults to false so the model
   * keeps producing plain Markdown until the user opts in.
   */
  cards: boolean;

  /**
   * Allow the model to write `image.query` inside a card. Resolved
   * server-side AFTER the response completes (adds up to ~10s before
   * the `final` SSE event) and spends the configured image-search
   * provider quota. Requires `cards` to be on. Defaults to false.
   */
  cards_auto_images: boolean;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Per-format limits. All limits are advisory for the model and enforced by
 * the renderer where practical.
 *
 * Keep in sync with `DEFAULT_LIMITS` in `generative_ui.py`.
 */
export interface RenderingLimits {
  /** Maximum number of nodes in a single Mermaid diagram. */
  max_mermaid_nodes: number;

  /** Maximum number of data points in a single chart. */
  max_chart_points: number;

  /** Maximum number of rows in a single Markdown table. */
  max_table_rows: number;

  /**
   * Upper bound on cards emitted inside a single ```ui block. Advisory
   * for the model (the backend rule states "At most N cards per block")
   * and enforced by the renderer.
   */
  max_cards: number;

  /**
   * @deprecated Not consumed by any renderer or backend code path. The
   * effective `max_tokens` for an LLM call is controlled per-model (via
   * `config.toml` / `storage/models_budget.json`), not by Generative UI
   * settings. This field remains in the schema solely to preserve on-disk
   * compatibility with previously saved settings; the UI no longer exposes
   * it, and no new code should read or write it.
   */
  max_output_tokens: number;
}

// ---------------------------------------------------------------------------
// Top-level settings
// ---------------------------------------------------------------------------

/**
 * Complete rendering settings object.
 *
 * This is the exact shape persisted by the frontend store and sent to the
 * backend on every request. The backend reads `enabled`, `features`,
 * `limits`, and `max_retries`; all other keys are ignored.
 */
export interface RenderingSettings {
  /** Master switch. When false, the backend emits no rendering directive. */
  enabled: boolean;

  /** Active rendering features. */
  features: RenderingFeatures;

  /** Per-format limits. */
  limits: RenderingLimits;

  /** Retry budget for parse failures. Clamped to [0, 5]. */
  max_retries: number;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Named presets offered in the settings UI.
 *
 * `custom` is implicit: any settings object that does not exactly match one
 * of the other three presets is treated as custom.
 */
export type RenderingPreset = "minimal" | "balanced" | "full" | "custom";

/**
 * A preset definition, used by the settings tab to display options and to
 * apply a preset to the current settings.
 */
export interface RenderingPresetDefinition {
  id: Exclude<RenderingPreset, "custom">;
  title: string;
  description: string;
  features: RenderingFeatures;
  limits: RenderingLimits;
}

// ---------------------------------------------------------------------------
// Preset constants
// ---------------------------------------------------------------------------

/**
 * Default limits shared by every preset. Presets differ only in which
 * features they enable, not in the limits they apply.
 */
export const DEFAULT_LIMITS: RenderingLimits = {
  max_mermaid_nodes: 40,
  max_chart_points: 30,
  max_table_rows: 50,
  max_cards: 6,
  max_output_tokens: 4096,
};

/**
 * Default features when the settings have not been customized yet.
 * Equivalent to the `balanced` preset.
 */
export const DEFAULT_FEATURES: RenderingFeatures = {
  mermaid: true,
  latex: true,
  charts: true,
  code_highlighting: true,
  // v3: Cards and auto-image are OPT-IN on every preset. The `full`
  // preset enables `cards` but still leaves `cards_auto_images` off,
  // because enabling it spends the search provider quota without a
  // user click — a separate, explicit decision.
  cards: false,
  cards_auto_images: false,
};

/**
 * The complete default settings object.
 */
export const DEFAULT_SETTINGS: RenderingSettings = {
  enabled: true,
  features: DEFAULT_FEATURES,
  limits: DEFAULT_LIMITS,
  max_retries: 1,
};

/**
 * The three selectable presets.
 *
 * Ordering here determines the display order in the settings tab.
 */
export const PRESET_DEFINITIONS: readonly RenderingPresetDefinition[] = [
  {
    id: "minimal",
    title: "Minimal",
    description:
      "Plain Markdown only. No diagrams, no math, no charts, no cards. Lowest token cost.",
    features: {
      mermaid: false,
      latex: false,
      charts: false,
      code_highlighting: true,
      cards: false,
      cards_auto_images: false,
    },
    limits: DEFAULT_LIMITS,
  },
  {
    id: "balanced",
    title: "Balanced (Recommended)",
    description:
      "Markdown, LaTeX math, and Mermaid diagrams. Charts are enabled for structured data.",
    features: {
      mermaid: true,
      latex: true,
      charts: true,
      code_highlighting: true,
      cards: false,
      cards_auto_images: false,
    },
    limits: DEFAULT_LIMITS,
  },
  {
    id: "full",
    title: "Full Power",
    description:
      "Every rendering feature enabled with extended limits for large reports. UI cards are enabled with a larger card cap; auto-image search stays off until you explicitly opt in.",
    features: {
      mermaid: true,
      latex: true,
      charts: true,
      code_highlighting: true,
      cards: true,
      // Deliberately off even in `full`: opting into auto-image search
      // spends the search provider quota per message. It must be a
      // separate, explicit user decision.
      cards_auto_images: false,
    },
    limits: {
      max_mermaid_nodes: 80,
      max_chart_points: 60,
      max_table_rows: 100,
      max_cards: 12,
      max_output_tokens: 8192,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Runtime counters displayed in the settings tab.
 *
 * These are session-scoped and reset on page reload. They are not persisted.
 */
export interface RenderingTelemetry {
  /** Total number of times the renderer ran on a message. */
  totalRenders: number;

  /** Successfully rendered messages without any fallback. */
  successfulRenders: number;

  /** Count of Mermaid parse errors encountered. */
  mermaidErrors: number;

  /** Count of chart payload errors encountered. */
  chartErrors: number;

  /** Count of LaTeX parse errors encountered. */
  latexErrors: number;

  /**
   * Count of card render errors encountered (invalid JSON, unknown
   * layout, missing required fields, unresolved image ref). v3.
   */
  cardErrors: number;

  /** Latency of the last successful render, in milliseconds. */
  lastRenderLatencyMs: number;
}

export const EMPTY_TELEMETRY: RenderingTelemetry = {
  totalRenders: 0,
  successfulRenders: 0,
  mermaidErrors: 0,
  chartErrors: 0,
  latexErrors: 0,
  cardErrors: 0,
  lastRenderLatencyMs: 0,
};

// ---------------------------------------------------------------------------
// Chart payloads (parsed from ```chart fenced blocks)
// ---------------------------------------------------------------------------

/**
 * Chart types supported by the Recharts-based renderer.
 */
export type ChartType = "bar" | "line" | "area" | "donut" | "pie";

/**
 * Simple single-series chart payload.
 *
 * The `data` array is a list of {label, value} pairs. Used for bar, line,
 * area, donut, and pie charts with a single measure.
 */
export interface SimpleChartPayload {
  type: ChartType;
  title: string;
  unit?: string;
  description?: string;
  data: Array<{ label: string; value: number }>;
}

/**
 * Multi-series chart payload.
 *
 * The `data` array is a list of records. Each record contains the value of
 * `xAxisKey` and one key per entry in `seriesKeys`. Used for grouped bars,
 * multi-line charts, and stacked areas.
 */
export interface MultiSeriesChartPayload {
  type: "bar" | "line" | "area";
  title: string;
  unit?: string;
  description?: string;
  data: Array<Record<string, string | number>>;
  xAxisKey: string;
  seriesKeys: string[];
}

/**
 * Union of every supported chart payload shape.
 */
export type ChartPayload = SimpleChartPayload | MultiSeriesChartPayload;

// ---------------------------------------------------------------------------
// Mermaid xychart payload (parsed from ```mermaid xychart-beta blocks)
// ---------------------------------------------------------------------------

/**
 * Mermaid's native xychart format is parsed by Mermaid itself, not by us.
 * This interface is provided for documentation and type-safety purposes
 * only; the raw source is passed to Mermaid verbatim.
 */
export interface MermaidXychartSource {
  /** Chart title, drawn above the axes. */
  title: string;

  /** X-axis labels in order. */
  xAxis: string[];

  /** Optional Y-axis label and range, e.g. "USD (millions)" 0 --> 100. */
  yAxis?: string;

  /** Series values. Length must match `xAxis`. */
  values: number[];

  /** Series kind. `bar` renders bars, `line` renders a line. */
  seriesKind: "bar" | "line";
}

// ---------------------------------------------------------------------------
// Settings validation helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether a given settings object exactly matches one of the named
 * presets. Returns `custom` when no preset matches.
 */
export function classifyPreset(settings: RenderingSettings): RenderingPreset {
  for (const preset of PRESET_DEFINITIONS) {
    if (
      preset.features.mermaid === settings.features.mermaid &&
      preset.features.latex === settings.features.latex &&
      preset.features.charts === settings.features.charts &&
      preset.features.code_highlighting === settings.features.code_highlighting &&
      // v3: compare `cards` so enabling it flips minimal/balanced to
      // `custom`. `cards_auto_images` is deliberately NOT compared: any
      // of the three presets may carry it, and the preset label should
      // not flip to `custom` just because the user opted into auto
      // image search on top of their chosen preset.
      preset.features.cards === settings.features.cards &&
      preset.limits.max_mermaid_nodes === settings.limits.max_mermaid_nodes &&
      preset.limits.max_chart_points === settings.limits.max_chart_points &&
      preset.limits.max_table_rows === settings.limits.max_table_rows &&
      preset.limits.max_cards === settings.limits.max_cards &&
      preset.limits.max_output_tokens === settings.limits.max_output_tokens
    ) {
      return preset.id;
    }
  }
  return "custom";
}

/**
 * Applies a preset to a settings object, preserving the `enabled` and
 * `max_retries` fields.
 */
export function applyPreset(
  settings: RenderingSettings,
  presetId: Exclude<RenderingPreset, "custom">,
): RenderingSettings {
  const preset = PRESET_DEFINITIONS.find((p) => p.id === presetId);
  if (!preset) return settings;
  return {
    ...settings,
    features: { ...preset.features },
    limits: { ...preset.limits },
  };
}

/**
 * Returns true when at least one rendering feature is enabled.
 * Used to short-circuit renderer setup when nothing visual is possible.
 */
export function hasAnyFeatureEnabled(features: RenderingFeatures): boolean {
  return (
    features.mermaid ||
    features.latex ||
    features.charts ||
    features.code_highlighting ||
    features.cards
  );
}
