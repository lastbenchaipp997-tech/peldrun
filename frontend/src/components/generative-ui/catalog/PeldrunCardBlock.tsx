// frontend/src/components/generative-ui/catalog/PeldrunCardBlock.tsx
//
// Card / grid renderer for the Markdown pipeline.
//
// Invoked by MarkdownRenderer.tsx as the handler for fenced code blocks
// tagged `ui`. Follows the same conventions as PeldrunChartBlock:
//   - props { source, telemetry }
//   - limits + retry budget read from the generative-ui store
//   - one telemetry event per unique source (ref-guarded)
//   - error box with "View source" on invalid payloads
//
// Differences:
//   - While the fenced block is still streaming (incomplete JSON) a skeleton
//     is shown instead of an error.
//   - Layout uses LOGICAL CSS (ms/me/text-start/flex-row) + dir="auto" per
//     card, so Arabic and English cards render correctly side by side.
//   - The model never supplies executable content: icons come from a
//     whitelist, images from host-resolved refs, actions are plain prompts.

"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  Globe,
  Info,
  LayoutGrid,
  Lightbulb,
  LineChart,
  Loader2,
  Map as MapIcon,
  MapPin,
  Package,
  PieChart,
  Route,
  Star,
  Table2,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { useGenerativeUIStore } from "../store";
import { UiAlert, UiKpi } from "./UiBlocks";
import {
  parseUiPayload,
  safeHttpsUrl,
  type CardAccent,
  type CardAccentStyle,
  type CardIconKey,
  type CardImageSpec,
  type CardPayload,
  type CardTag,
  type FlowPayload,
  type FormPayload,
  type FormQuestion,
  type GridPayload,
} from "./cards";

// ---------------------------------------------------------------------------
// Host integration (provided once, near the message list)
// ---------------------------------------------------------------------------

export interface CardRuntime {
  /** Maps a model-supplied `image.ref` to a URL the browser may load. */
  resolveImage?: (ref: string) => string | null | undefined;
  /** Maps a model-supplied `image.query` to a URL (backend-resolved). */
  resolveImageByQuery?: (query: string) => string | null | undefined;
  /** Sends `prompt` as a new user message (used by card actions). */
  sendPrompt?: (prompt: string) => void;
  /** Allow `image.url` (https) supplied directly by the model. Default false. */
  allowRemoteImageUrls?: boolean;
  /**
   * True while the host still expects `image.ref` / `image.query` to be
   * resolved for this message (the answer is streaming, or the backend is
   * still building the image gallery). While true, cards that declare an
   * image but have no URL yet render a loading placeholder instead of
   * nothing. The host MUST set it back to false once the gallery has
   * arrived or resolution has definitively failed; otherwise the
   * placeholder never goes away. Default false.
   */
  imagesPending?: boolean;
}

export const CardRuntimeContext = createContext<CardRuntime>({});

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const ICONS: Record<CardIconKey, LucideIcon> = {
  map: MapIcon,
  route: Route,
  pin: MapPin,
  "chart-line": LineChart,
  "chart-bar": BarChart3,
  "chart-pie": PieChart,
  flow: Workflow,
  grid: LayoutGrid,
  table: Table2,
  calendar: Calendar,
  activity: Activity,
  document: FileText,
  info: Info,
  star: Star,
  users: Users,
  clock: Clock,
  globe: Globe,
  package: Package,
  idea: Lightbulb,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const join = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

function resolveImageSrc(
  image: CardImageSpec | undefined,
  runtime: CardRuntime,
): string | null {
  if (!image) return null;
  const accept = (u: string | null | undefined): string | null =>
    u && (u.startsWith("/") || safeHttpsUrl(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u))
      ? u
      : null;
  if (image.ref) {
    const hit = accept(runtime.resolveImage?.(image.ref));
    if (hit) return hit;
  }
  if (image.query) {
    const hit = accept(runtime.resolveImageByQuery?.(image.query));
    if (hit) return hit;
  }
  if (image.url && runtime.allowRemoteImageUrls) return image.url;
  return null;
}

/**
 * Loading placeholder for card media. It fills its positioned parent
 * (`absolute inset-0`), so it occupies exactly the footprint of the final
 * <img> and nothing shifts when the picture arrives.
 *
 * Two layers kept as siblings: a pulsing block (skeleton) and a static
 * centered spinner. Separate elements are required so the spinner does
 * not inherit the opacity pulse. `motion-reduce` disables both animations
 * for users who prefer reduced motion; the skeleton block alone still
 * signals the loading state.
 */
function ImageLoader({ small = false }: { small?: boolean }): React.JSX.Element {
  return (
    <>
      <div
        aria-hidden="true"
        // bg-muted (no alpha) pulses between ~100% and ~50% opacity under
        // animate-pulse, so it stays visible in light and dark themes.
        className="absolute inset-0 animate-pulse bg-muted motion-reduce:animate-none"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center"
      >
        <Loader2
          size={small ? 14 : 22}
          className="animate-spin text-muted-foreground/70 motion-reduce:animate-none"
        />
      </div>
    </>
  );
}

const GRID_COLS: Record<GridPayload["columns"], string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
};

/**
 * v4: soft pastel gradients keyed by `CardAccent`. Every color is
 * spelled out as a full Tailwind class string — no dynamic construction
 * — so the JIT compiler sees the classes in the source and ships them.
 *
 * Light: `from-<c>-50 to-<c>-100` diagonal + `<c>-200` border.
 * Dark : `from-<c>-950/40 to-<c>-900/20` + `<c>-800/60` border.
 *        The alpha keeps the tint legible on a dark card without
 *        washing out the text.
 */
/**
 * v4.2: nested map — every accent × every style. All class strings are
 * literal so Tailwind's JIT ships them; no class is ever constructed
 * dynamically.
 *
 *   tinted   : soft gradient background + colored border (default)
 *   outlined : 2px colored border, transparent fill
 *   minimal  : very light tint, thin border
 */
const ACCENT_CLASSES: Record<CardAccent, Record<CardAccentStyle, string>> = {
  blue: {
    tinted:   "border-blue-200    bg-gradient-to-br from-blue-50    to-blue-100    dark:border-blue-800/60    dark:from-blue-950/40    dark:to-blue-900/20",
    outlined: "border-2 border-blue-300    bg-transparent dark:border-blue-700/70",
    minimal:  "border border-blue-200/70    bg-blue-50/40    dark:border-blue-800/40    dark:bg-blue-950/10",
  },
  sky: {
    tinted:   "border-sky-200     bg-gradient-to-br from-sky-50     to-sky-100     dark:border-sky-800/60     dark:from-sky-950/40     dark:to-sky-900/20",
    outlined: "border-2 border-sky-300     bg-transparent dark:border-sky-700/70",
    minimal:  "border border-sky-200/70     bg-sky-50/40     dark:border-sky-800/40     dark:bg-sky-950/10",
  },
  cyan: {
    tinted:   "border-cyan-200    bg-gradient-to-br from-cyan-50    to-cyan-100   dark:border-cyan-800/60    dark:from-cyan-950/40    dark:to-cyan-900/20",
    outlined: "border-2 border-cyan-300    bg-transparent dark:border-cyan-700/70",
    minimal:  "border border-cyan-200/70    bg-cyan-50/40    dark:border-cyan-800/40    dark:bg-cyan-950/10",
  },
  teal: {
    tinted:   "border-teal-200    bg-gradient-to-br from-teal-50    to-teal-100    dark:border-teal-800/60    dark:from-teal-950/40    dark:to-teal-900/20",
    outlined: "border-2 border-teal-300    bg-transparent dark:border-teal-700/70",
    minimal:  "border border-teal-200/70    bg-teal-50/40    dark:border-teal-800/40    dark:bg-teal-950/10",
  },
  emerald: {
    tinted:   "border-emerald-200 bg-gradient-to-br from-emerald-50 to-emerald-100 dark:border-emerald-800/60 dark:from-emerald-950/40 dark:to-emerald-900/20",
    outlined: "border-2 border-emerald-300 bg-transparent dark:border-emerald-700/70",
    minimal:  "border border-emerald-200/70 bg-emerald-50/40 dark:border-emerald-800/40 dark:bg-emerald-950/10",
  },
  green: {
    tinted:   "border-green-200   bg-gradient-to-br from-green-50   to-green-100   dark:border-green-800/60   dark:from-green-950/40   dark:to-green-900/20",
    outlined: "border-2 border-green-300   bg-transparent dark:border-green-700/70",
    minimal:  "border border-green-200/70   bg-green-50/40   dark:border-green-800/40   dark:bg-green-950/10",
  },
  lime: {
    tinted:   "border-lime-200    bg-gradient-to-br from-lime-50    to-lime-100    dark:border-lime-800/60    dark:from-lime-950/40    dark:to-lime-900/20",
    outlined: "border-2 border-lime-300    bg-transparent dark:border-lime-700/70",
    minimal:  "border border-lime-200/70    bg-lime-50/40    dark:border-lime-800/40    dark:bg-lime-950/10",
  },
  amber: {
    tinted:   "border-amber-200   bg-gradient-to-br from-amber-50   to-amber-100   dark:border-amber-800/60   dark:from-amber-950/40   dark:to-amber-900/20",
    outlined: "border-2 border-amber-300   bg-transparent dark:border-amber-700/70",
    minimal:  "border border-amber-200/70   bg-amber-50/40   dark:border-amber-800/40   dark:bg-amber-950/10",
  },
  yellow: {
    tinted:   "border-yellow-200  bg-gradient-to-br from-yellow-50  to-yellow-100  dark:border-yellow-800/60  dark:from-yellow-950/40  dark:to-yellow-900/20",
    outlined: "border-2 border-yellow-300  bg-transparent dark:border-yellow-700/70",
    minimal:  "border border-yellow-200/70  bg-yellow-50/40  dark:border-yellow-800/40  dark:bg-yellow-950/10",
  },
  orange: {
    tinted:   "border-orange-200  bg-gradient-to-br from-orange-50  to-orange-100  dark:border-orange-800/60  dark:from-orange-950/40  dark:to-orange-900/20",
    outlined: "border-2 border-orange-300  bg-transparent dark:border-orange-700/70",
    minimal:  "border border-orange-200/70  bg-orange-50/40  dark:border-orange-800/40  dark:bg-orange-950/10",
  },
  red: {
    tinted:   "border-red-200     bg-gradient-to-br from-red-50     to-red-100     dark:border-red-800/60     dark:from-red-950/40     dark:to-red-900/20",
    outlined: "border-2 border-red-300     bg-transparent dark:border-red-700/70",
    minimal:  "border border-red-200/70     bg-red-50/40     dark:border-red-800/40     dark:bg-red-950/10",
  },
  rose: {
    tinted:   "border-rose-200    bg-gradient-to-br from-rose-50    to-rose-100    dark:border-rose-800/60    dark:from-rose-950/40    dark:to-rose-900/20",
    outlined: "border-2 border-rose-300    bg-transparent dark:border-rose-700/70",
    minimal:  "border border-rose-200/70    bg-rose-50/40    dark:border-rose-800/40    dark:bg-rose-950/10",
  },
  pink: {
    tinted:   "border-pink-200    bg-gradient-to-br from-pink-50    to-pink-100    dark:border-pink-800/60    dark:from-pink-950/40    dark:to-pink-900/20",
    outlined: "border-2 border-pink-300    bg-transparent dark:border-pink-700/70",
    minimal:  "border border-pink-200/70    bg-pink-50/40    dark:border-pink-800/40    dark:bg-pink-950/10",
  },
  fuchsia: {
    tinted:   "border-fuchsia-200 bg-gradient-to-br from-fuchsia-50 to-fuchsia-100 dark:border-fuchsia-800/60 dark:from-fuchsia-950/40 dark:to-fuchsia-900/20",
    outlined: "border-2 border-fuchsia-300 bg-transparent dark:border-fuchsia-700/70",
    minimal:  "border border-fuchsia-200/70 bg-fuchsia-50/40 dark:border-fuchsia-800/40 dark:bg-fuchsia-950/10",
  },
  purple: {
    tinted:   "border-purple-200  bg-gradient-to-br from-purple-50  to-purple-100  dark:border-purple-800/60  dark:from-purple-950/40  dark:to-purple-900/20",
    outlined: "border-2 border-purple-300  bg-transparent dark:border-purple-700/70",
    minimal:  "border border-purple-200/70  bg-purple-50/40  dark:border-purple-800/40  dark:bg-purple-950/10",
  },
  violet: {
    tinted:   "border-violet-200  bg-gradient-to-br from-violet-50  to-violet-100  dark:border-violet-800/60  dark:from-violet-950/40  dark:to-violet-900/20",
    outlined: "border-2 border-violet-300  bg-transparent dark:border-violet-700/70",
    minimal:  "border border-violet-200/70  bg-violet-50/40  dark:border-violet-800/40  dark:bg-violet-950/10",
  },
  indigo: {
    tinted:   "border-indigo-200  bg-gradient-to-br from-indigo-50  to-indigo-100  dark:border-indigo-800/60  dark:from-indigo-950/40  dark:to-indigo-900/20",
    outlined: "border-2 border-indigo-300  bg-transparent dark:border-indigo-700/70",
    minimal:  "border border-indigo-200/70  bg-indigo-50/40  dark:border-indigo-800/40  dark:bg-indigo-950/10",
  },
  slate: {
    tinted:   "border-slate-200   bg-gradient-to-br from-slate-50   to-slate-100   dark:border-slate-700/60   dark:from-slate-900/60   dark:to-slate-900/40",
    outlined: "border-2 border-slate-300   bg-transparent dark:border-slate-600/70",
    minimal:  "border border-slate-200/70   bg-slate-50/40   dark:border-slate-700/40   dark:bg-slate-900/20",
  },
};

/**
 * v4.2: pastel pill classes for tags. All tags render with this same
 * light style regardless of `CardAccentStyle` — pill backgrounds that
 * carry a 2px border or a heavy gradient would compete visually with
 * the card body.
 */
const TAG_ACCENT_CLASSES: Record<CardAccent, string> = {
  blue:    "bg-blue-100    text-blue-700    dark:bg-blue-900/40    dark:text-blue-300",
  sky:     "bg-sky-100     text-sky-700     dark:bg-sky-900/40     dark:text-sky-300",
  cyan:    "bg-cyan-100    text-cyan-700    dark:bg-cyan-900/40    dark:text-cyan-300",
  teal:    "bg-teal-100    text-teal-700    dark:bg-teal-900/40    dark:text-teal-300",
  emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  green:   "bg-green-100   text-green-700   dark:bg-green-900/40   dark:text-green-300",
  lime:    "bg-lime-100    text-lime-700    dark:bg-lime-900/40    dark:text-lime-300",
  amber:   "bg-amber-100   text-amber-700   dark:bg-amber-900/40   dark:text-amber-300",
  yellow:  "bg-yellow-100  text-yellow-700  dark:bg-yellow-900/40  dark:text-yellow-300",
  orange:  "bg-orange-100  text-orange-700  dark:bg-orange-900/40  dark:text-orange-300",
  red:     "bg-red-100     text-red-700     dark:bg-red-900/40     dark:text-red-300",
  rose:    "bg-rose-100    text-rose-700    dark:bg-rose-900/40    dark:text-rose-300",
  pink:    "bg-pink-100    text-pink-700    dark:bg-pink-900/40    dark:text-pink-300",
  fuchsia: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300",
  purple:  "bg-purple-100  text-purple-700  dark:bg-purple-900/40  dark:text-purple-300",
  violet:  "bg-violet-100  text-violet-700  dark:bg-violet-900/40  dark:text-violet-300",
  indigo:  "bg-indigo-100  text-indigo-700  dark:bg-indigo-900/40  dark:text-indigo-300",
  slate:   "bg-slate-100   text-slate-700   dark:bg-slate-800/60   dark:text-slate-300",
};

// ---------------------------------------------------------------------------
// Single card
// ---------------------------------------------------------------------------

function UiCard({ card }: { card: CardPayload }): React.JSX.Element {
  const runtime = useContext(CardRuntimeContext);

  // Derived loading state. We keep the *src that finished loading* and
  // the *src that failed* instead of two booleans, because a boolean
  // reset via useEffect races against the browser's microtask-scheduled
  // `load` event on cached images (the effect lands after the load and
  // clobbers it, leaving the skeleton spinning forever). Comparing the
  // remembered src to the current one is race-free: when the image
  // source changes, the flag flips back to "not loaded" automatically,
  // and a stale `onLoad` from a previous src cannot mark the new one
  // as loaded.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  // Memoize the resolver output so an unstable host implementation
  // (e.g. one that appends a cache-buster or a signed token on every
  // call) cannot retrigger a load on every render. `card.image` is
  // stable because `parseUiPayload` is memoized upstream.
  const src = useMemo(
    () => resolveImageSrc(card.image, runtime),
    [card.image, runtime],
  );

  const imgRef = useRef<HTMLImageElement>(null);

  const imgLoaded = src !== null && loadedSrc === src;
  const imgFailed = src !== null && failedSrc === src;
  const showImage = src !== null && !imgFailed;
  // The card declares an image that the host has not resolved yet (backend
  // still building the gallery). Reserve the media slot and show the loader
  // so the layout does not jump when the URL arrives.
  const imagePending =
    src === null &&
    runtime.imagesPending === true &&
    Boolean(card.image?.ref || card.image?.query);
  const showMedia = showImage || imagePending;
  // Overlay needs a media slot; without one it degrades to a plain vertical card.
  const layout =
    card.layout === "overlay" && !showMedia ? "vertical" : card.layout;

  // Safety net: if the image finished loading before React attached the
  // `load` handler (cached image + hydration), onLoad never fires and the
  // loader would spin forever. Detect that case after mount. Only the
  // "loaded" outcome is inferred here; failures are left to onError because
  // `complete` is unreliable for deferred lazy images in some browsers.
  useEffect(() => {
    const el = imgRef.current;
    if (src !== null && el && el.complete && el.naturalWidth > 0) {
      setLoadedSrc(src);
    }
  }, [src]);

  const overlay = layout === "overlay";
  const tile = layout === "tile";
  const compact = layout === "compact";
  const sideMedia = layout === "media-start" || layout === "media-end";

  const Icon = card.icon ? ICONS[card.icon] : null;
  const fitClass = card.image?.fit === "contain" ? "object-contain" : "object-cover";

  const muted = overlay ? "text-white/80" : "text-muted-foreground";

  // v4.2: accent + style. Overlay is still excluded because its
  // background is fully covered by the image and its dark scrim —
  // tinting would be invisible and would confuse the fallback path
  // (overlay degrades to vertical on a missing image).
  const accentClasses =
    card.accent && layout !== "overlay"
      ? ACCENT_CLASSES[card.accent][card.style ?? "tinted"]
      : null;
  const defaultBorderBg = tile
    ? "border-transparent bg-muted/50"
    : overlay
    ? "border-transparent"
    : "border-border/70 bg-card/60";

  const rootClass = join(
    "relative flex overflow-hidden rounded-md border text-start",
    accentClasses ?? defaultBorderBg,
    layout === "vertical" && "flex-col",
    layout === "media-start" && "flex-row",
    layout === "media-end" && "flex-row-reverse",
    overlay && "min-h-[12rem] flex-col justify-end text-white",
    tile && "flex-col items-start gap-2 p-3.5",
    compact && "flex-row items-center gap-3 p-2.5",
  );

  const imageNode =
    showMedia && !tile ? (
      // Wrapper owns the layout sizing (aspect ratio, side-rail width,
      // overlay positioning, compact square) so the skeleton occupies
      // exactly the same footprint as the final <img>. The image itself
      // is absolutely positioned inside so it always fills the wrapper
      // regardless of flex-stretch quirks.
      <div
        aria-busy={!imgLoaded}
        className={join(
          "overflow-hidden bg-muted/30",
          !overlay && "relative",
          layout === "vertical" && "aspect-video w-full",
          sideMedia && "w-28 shrink-0 self-stretch sm:w-36",
          overlay && "absolute inset-0 w-full",
          compact && "h-10 w-10 shrink-0 rounded-lg",
        )}
      >
        {!imgLoaded && <ImageLoader small={compact} />}
        {src !== null && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={src}
            alt={card.image?.alt ?? card.title}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            onLoad={() => setLoadedSrc(src)}
            onError={() => setFailedSrc(src)}
            className={join(
              "absolute inset-0 h-full w-full transition-opacity duration-200",
              fitClass,
              imgLoaded ? "opacity-100" : "opacity-0",
            )}
          />
        )}
      </div>
    ) : null;

  const iconNode = Icon ? (
    <Icon
      size={tile ? 20 : 16}
      aria-hidden="true"
      className={join("shrink-0", overlay ? "text-white" : "text-primary")}
    />
  ) : null;

  const titleText = card.href ? (
    <a
      href={card.href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
    >
      {card.title}
      <ExternalLink size={12} aria-hidden="true" className="shrink-0 opacity-70" />
    </a>
  ) : (
    card.title
  );

  const actions =
    !compact && card.actions.length > 0 ? (
      <div className="mt-1 flex flex-wrap gap-2">
        {card.actions.map((a, i) => {
          const cls = join(
            "rounded-sm border px-2.5 py-1 text-xs font-medium transition-colors",
            overlay
              ? "border-white/40 text-white hover:bg-white/15"
              : "border-border bg-black text-card hover:bg-muted hover:text-black",
          );
          if (a.href && !a.prompt) {
            return (
              <a key={i} href={a.href} target="_blank" rel="noopener noreferrer" className={cls}>
                {a.label}
              </a>
            );
          }
          if (a.prompt && runtime.sendPrompt) {
            return (
              <button
                key={i}
                type="button"
                className={cls}
                onClick={() => runtime.sendPrompt?.(a.prompt as string)}
              >
                {a.label}
              </button>
            );
          }
          return null; // prompt action without a host handler: hide it
        })}
      </div>
    ) : null;

  const contentClass = join(
    "min-w-0",
    compact && "flex-1",
    !compact && !tile && !overlay && "flex flex-1 flex-col gap-2 p-3.5",
    overlay && "relative z-10 flex flex-col gap-1.5 p-4",
    tile && "flex flex-col gap-1.5",
  );

  return (
    <div dir="auto" className={rootClass}>
      {imageNode}
      {overlay && (
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0.15) 70%)",
          }}
        />
      )}

      {compact && !showMedia && iconNode && (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          {iconNode}
        </div>
      )}

      <div className={contentClass}>
        {tile && iconNode}
        <h4
          className={join(
            "flex items-center gap-1.5 font-semibold font-serif leading-snug",
            compact ? "truncate text-sm" : "text-sm sm:text-[15px]",
            overlay && "text-white",
          )}
        >
          {!tile && !compact && iconNode}
          <span className="min-w-0">{titleText}</span>
        </h4>

        {card.subtitle && (
          <p className={join("text-xs", muted, compact && "truncate")}>
            {card.subtitle}
          </p>
        )}

        {!compact && !tile && card.description && (
          <p className={join("line-clamp-3 text-xs leading-relaxed", overlay ? "text-white/90" : "text-foreground/80")}>
            {card.description}
          </p>
        )}

        {tile && card.tags.length > 0 && (
          <p className={join("text-xs", muted)}>
            {card.tags
              .map((t) => (typeof t === "string" ? t : t.label))
              .join(" · ")}
          </p>
        )}

        {!tile && !compact && card.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {card.tags.map((tag, i) => {
              const isObj = typeof tag === "object" && tag !== null;
              const label = isObj ? tag.label : tag;
              // v4.2: object tags may override the accent; string tags
              // inherit the card's accent. Overlay always uses the
              // translucent-white pill so the pill reads on the image
              // scrim regardless of any per-tag color.
              const tagAccent: CardAccent | undefined = isObj
                ? (tag as { accent?: CardAccent }).accent ?? card.accent
                : card.accent;
              const pillClass = overlay
                ? "bg-white/20 text-white"
                : tagAccent
                ? TAG_ACCENT_CLASSES[tagAccent]
                : "bg-muted text-muted-foreground";
              return (
                <span
                  key={i}
                  className={join(
                    "rounded-sm shadow-sm px-2 py-0.5 text-[11px]",
                    pillClass,
                  )}
                >
                  {label}
                </span>
              );
            })}
          </div>
        )}

        {!tile && !compact && card.stats.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {card.stats.map((s, i) => (
              <div key={i} className="min-w-0">
                <dt className={join("text-[11px]", muted)}>{s.label}</dt>
                <dd className="truncate text-sm font-medium">{s.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {actions}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flow block (v4) — sequential / layered explanation map
// ---------------------------------------------------------------------------

/**
 * Renders a `flow` payload as a connected sequence of cards.
 *
 * Vertical (default): stacked cards with a downward chevron between them.
 * Horizontal: row of cards with rightward chevrons (collapses to
 * vertical + downward chevrons on narrow viewports so nothing overflows).
 *
 * Each item reuses `UiCard`, so accents, icons, images, and titles
 * behave identically to a standalone card. `stats` and `actions` are
 * intentionally ignored by the flow layout — see the comment on
 * `FlowPayload` in cards.ts.
 */
function UiFlow({ flow }: { flow: FlowPayload }): React.JSX.Element {
  const horizontal = flow.direction === "horizontal";
  return (
    <div className="my-3 space-y-2">
      {flow.title && (
        <h3 dir="auto" className="text-sm font-semibold text-foreground">
          {flow.title}
        </h3>
      )}
      <div
        className={
          horizontal
            ? "flex flex-col gap-0 md:flex-row md:items-stretch"
            : "flex flex-col gap-0"
        }
      >
        {flow.items.map((card, i) => (
          <React.Fragment key={i}>
            <div className={horizontal ? "md:flex-1 md:min-w-0" : ""}>
              <UiCard card={card} />
            </div>
            {i < flow.items.length - 1 && (
              <div
                aria-hidden="true"
                className="flex shrink-0 items-center justify-center py-1 text-muted-foreground md:px-1 md:py-0"
              >
                {horizontal ? (
                  <>
                    <ChevronDown size={16} className="md:hidden" />
                    <ChevronRight size={16} className="hidden md:block" />
                  </>
                ) : (
                  <ChevronDown size={16} />
                )}
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
      {flow.hidden > 0 && (
        <div className="text-xs text-muted-foreground">+{flow.hidden}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form block (v4.2) — interactive question card
// ---------------------------------------------------------------------------

/**
 * Renders a `form` payload as an interactive question set.
 *
 * State is local to this component. On submit:
 *   1. The `submitPrompt` template (if any) has each `{{qid}}`
 *      placeholder replaced with the comma-joined labels the user
 *      selected for that question.
 *   2. If `submitPrompt` is missing, a plain "label: a, b" list is
 *      built instead.
 *   3. The resulting string is handed to
 *      `CardRuntimeContext.sendPrompt`, which ChatContainer forwards
 *      into `handleStartTask`. The archived form turn stays visible
 *      above the new exchange.
 *
 * After a successful submit, the widget freezes so the user cannot
 * send the same answers twice. A page refresh resets the form — this
 * is acceptable because the answers have already been dispatched to
 * the model at that point, and the message list carries the context
 * forward.
 */
function UiForm({ form }: { form: FormPayload }): React.JSX.Element {
  const runtime = useContext(CardRuntimeContext);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [submitted, setSubmitted] = useState(false);

  const accentClasses = form.accent
    ? ACCENT_CLASSES[form.accent][form.style ?? "tinted"]
    : "border-border/70 bg-card/60";

  const toggle = (q: FormQuestion, optId: string) => {
    if (submitted) return;
    setAnswers((prev) => {
      const current = prev[q.id] || [];
      let next: string[];
      if (q.type === "single") {
        next = current.includes(optId) ? [] : [optId];
      } else {
        next = current.includes(optId)
          ? current.filter((x) => x !== optId)
          : [...current, optId];
      }
      return { ...prev, [q.id]: next };
    });
  };

  const isValid = form.questions.every(
    (q) => !q.required || (answers[q.id]?.length ?? 0) > 0,
  );

  const buildPrompt = (): string => {
    // Map of question id -> option id -> label. Used both for template
    // substitution and for the fallback plain-list output.
    const labelMap: Record<string, Record<string, string>> = {};
    for (const q of form.questions) {
      labelMap[q.id] = {};
      for (const opt of q.options) labelMap[q.id][opt.id] = opt.label;
    }

    if (form.submitPrompt) {
      return form.submitPrompt.replace(
        /\{\{(\w+)\}\}/g,
        (_match, key: string) => {
          const q = form.questions.find((x) => x.id === key);
          if (!q) return `{{${key}}}`;
          const selected = answers[q.id] || [];
          return selected
            .map((id) => labelMap[q.id]?.[id] ?? id)
            .join(", ");
        },
      );
    }

    const lines: string[] = [];
    for (const q of form.questions) {
      const selected = answers[q.id] || [];
      if (selected.length === 0) continue;
      const labels = selected.map((id) => labelMap[q.id]?.[id] ?? id);
      lines.push(`${q.label}: ${labels.join(", ")}`);
    }
    return lines.join("\n");
  };

  const handleSubmit = () => {
    if (!isValid || submitted || !runtime.sendPrompt) return;
    setSubmitted(true);
    runtime.sendPrompt(buildPrompt());
  };

  const canSubmit = isValid && !submitted && Boolean(runtime.sendPrompt);

  return (
    <div
      dir="auto"
      className={join("my-3 rounded-xl border p-4 space-y-4", accentClasses)}
    >
      {(form.title || form.description) && (
        <div className="space-y-1">
          {form.title && (
            <h3 className="text-sm font-semibold text-foreground">
              {form.title}
            </h3>
          )}
          {form.description && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {form.description}
            </p>
          )}
        </div>
      )}

      <div className="space-y-3">
        {form.questions.map((q) => {
          const selected = answers[q.id] || [];
          const inputType = q.type === "single" ? "radio" : "checkbox";
          return (
            <fieldset key={q.id} className="space-y-1.5">
              <legend className="text-xs font-semibold text-foreground">
                {q.label}
                {q.required && (
                  <span
                    className="text-rose-500 ml-1"
                    aria-label="required"
                    title="Required"
                  >
                    *
                  </span>
                )}
              </legend>
              {q.description && (
                <p className="text-[11px] text-muted-foreground">
                  {q.description}
                </p>
              )}
              <div className="space-y-1.5 pt-0.5">
                {q.options.map((opt) => {
                  const isSelected = selected.includes(opt.id);
                  return (
                    <label
                      key={opt.id}
                      className={join(
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs cursor-pointer transition-colors",
                        isSelected
                          ? "border-primary/60 bg-primary/10 text-foreground"
                          : "border-border/60 bg-background/60 text-foreground/80 hover:bg-muted/40",
                        submitted && "cursor-not-allowed opacity-70",
                      )}
                    >
                      <input
                        type={inputType}
                        name={`form-${q.id}`}
                        checked={isSelected}
                        disabled={submitted}
                        onChange={() => toggle(q, opt.id)}
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      <span className="min-w-0">{opt.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[11px] text-muted-foreground">
          {submitted ? "✓ Submitted" : ""}
        </span>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={join(
            "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
            canSubmit
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted text-muted-foreground cursor-not-allowed",
          )}
        >
          {form.submitLabel}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public block
// ---------------------------------------------------------------------------

export interface PeldrunCardBlockProps {
  /** Raw JSON from the ```ui fenced block. */
  source: string;
  telemetry?: boolean;
}

export function PeldrunCardBlock({
  source,
  telemetry = true,
}: PeldrunCardBlockProps): React.JSX.Element {
  const maxCards = useGenerativeUIStore((s) => s.limits.max_cards);
  const maxRetries = useGenerativeUIStore((s) => s.max_retries);

  const recordedSourceRef = useRef<string | null>(null);

  const parsed = useMemo(
    () => parseUiPayload(source, maxCards ?? 6, maxRetries),
    [source, maxCards, maxRetries],
  );

  const settled = parsed.ok || !parsed.incomplete;

  useEffect(() => {
    if (!telemetry || !settled) return;
    if (recordedSourceRef.current === source) return;
    recordedSourceRef.current = source;
    const store = useGenerativeUIStore.getState();
    if (parsed.ok) store.recordSuccess(0);
    else store.recordError("card");
  }, [parsed, settled, source, telemetry]);

  // Still streaming: placeholder, not an error.
  if (!parsed.ok && parsed.incomplete) {
    return (
      <div
        aria-busy="true"
        className="my-3 h-28 animate-pulse rounded-md border border-border/50 bg-muted/40"
      />
    );
  }

  if (!parsed.ok) {
    return (
      <div className="my-3 space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-4">
        <div className="flex items-start gap-2.5 text-xs text-destructive">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <div className="space-y-0.5">
            <div className="font-semibold">Card Payload Error</div>
            <div className="font-mono text-[11px] opacity-90">{parsed.reason}</div>
          </div>
        </div>
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer transition-colors hover:text-foreground">
            View source
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-background/60 p-2.5 font-mono">
            {source}
          </pre>
        </details>
      </div>
    );
  }

  const { payload } = parsed;

  if (payload.type === "card") {
    return (
      <div className="my-3 max-w-xl">
        <UiCard card={payload} />
      </div>
    );
  }

  if (payload.type === "alert") {
    return <UiAlert alert={payload} />;
  }

  if (payload.type === "kpi") {
    return <UiKpi kpi={payload} />;
  }

  if (payload.type === "flow") {
    return <UiFlow flow={payload} />;
  }

  if (payload.type === "form") {
    return <UiForm form={payload} />;
  }

  return (
    <div className="my-3 space-y-2">
      {payload.title && (
        <h3 dir="auto" className="text-sm font-semibold text-foreground">
          {payload.title}
        </h3>
      )}
      <div className={join("grid gap-2.5", GRID_COLS[payload.columns])}>
        {payload.items.map((card, i) => (
          <UiCard key={i} card={card} />
        ))}
      </div>
      {payload.hidden > 0 && (
        <div className="text-xs text-muted-foreground">+{payload.hidden}</div>
      )}
    </div>
  );
}

export default PeldrunCardBlock;
