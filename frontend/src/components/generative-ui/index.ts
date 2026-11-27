// frontend/src/components/generative-ui/index.ts
//
// Public entry point for the generative-ui module.
//
// This module now owns the rendering settings system only. The actual
// rendering happens inside MarkdownRenderer.tsx, which reads the settings
// from this module's store and dispatches to the appropriate per-format
// components (PeldrunDiagram, PeldrunChartBlock, PeldrunPlainText).
//
// Consumers should import from this file rather than reaching into the
// individual modules directly. The internal structure may change without
// notice; the exports below are stable.

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

export type {
  ChartPayload,
  ChartType,
  MermaidXychartSource,
  MultiSeriesChartPayload,
  RenderingFeatureKey,
  RenderingFeatures,
  RenderingLimits,
  RenderingPreset,
  RenderingPresetDefinition,
  RenderingSettings,
  RenderingTelemetry,
  SimpleChartPayload,
} from "./types";

export {
  DEFAULT_FEATURES,
  DEFAULT_LIMITS,
  DEFAULT_SETTINGS,
  EMPTY_TELEMETRY,
  PRESET_DEFINITIONS,
  applyPreset,
  classifyPreset,
  hasAnyFeatureEnabled,
} from "./types";

// ---------------------------------------------------------------------------
// Store and selectors
// ---------------------------------------------------------------------------

export {
  getActivePreset,
  getEffectiveMaxTokens,
  getRenderingSettings,
  hasVisualOutputEnabled,
  useGenerativeUIStore,
} from "./store";

// ---------------------------------------------------------------------------
// Per-format renderer components
// ---------------------------------------------------------------------------
//
// These are the only rendering components that survived the OpenUI removal.
// Each one handles a single content type and is designed to be invoked by
// MarkdownRenderer.tsx as a `code` handler.

export { PeldrunDiagram } from "./catalog/PeldrunDiagram";
export { PeldrunChartBlock } from "./catalog/PeldrunChartBlock";
export { PeldrunPlainText } from "./catalog/PeldrunPlainText";

// ---------------------------------------------------------------------------
// v3: UI cards (```ui fenced JSON blocks)
// ---------------------------------------------------------------------------
//
// `PeldrunCardBlock` renders a single ```ui block. `CardRuntimeContext`
// supplies image and prompt handlers that the block uses to resolve
// `image.ref` / `image.query` and to dispatch action prompts.
//
// `buildGalleryIndex` / `normalizeQueryKey` are the canonical way to turn
// a persisted ```image_gallery block into a lookup table. They are
// exported so consumers (MarkdownRenderer in particular) do not need to
// know the gallery payload's shape.
//
// NOTE: these modules are introduced together with the cards feature.
// They do not exist in older builds; the import site is the one that
// gates their use (see `effectiveFeatures.cards` in markdown-renderer).
export {
  PeldrunCardBlock,
  CardRuntimeContext,
} from "./catalog/PeldrunCardBlock";
export type { CardRuntime } from "./catalog/PeldrunCardBlock";
export { buildGalleryIndex, normalizeQueryKey } from "./catalog/galleryRefs";

// ---------------------------------------------------------------------------
// Note on removed exports
// ---------------------------------------------------------------------------
//
// The following exports existed in previous versions and have been removed
// along with the OpenUI pipeline:
//
//   - OpenUIRenderer
//   - GenerativeUIRouter
//   - GenerativeUIErrorBoundary
//   - peldrunLibrary
//   - ALL_SUPPORTED_COMPONENTS
//   - All catalog components except the three listed above:
//       PeldrunCard, PeldrunMetric, PeldrunBadge, PeldrunAlert,
//       PeldrunProgress, PeldrunActionButton, PeldrunTable,
//       PeldrunTestResults, PeldrunAccordion, PeldrunCarousel,
//       PeldrunForm, PeldrunMotionWrapper, PeldrunChart,
//       PeldrunShadcnChart
//
// Any code still importing these names will fail to compile, which is the
// intended behavior. Fix the import site to use MarkdownRenderer instead.
