// frontend/src/components/chat/markdown-renderer.tsx
//
// Unified Markdown renderer for chat and agent messages.
//
// Performance:
//   The exported component is wrapped in React.memo so a parent re-render
//   (for example, a 1-second elapsed timer in the chat container) does not
//   re-run KaTeX or Mermaid when the message content is unchanged. Without
//   this wrapper, every timer tick would re-process every message and flood
//   the console with spurious KaTeX warnings.
//
// Dispatch:
//   ```mermaid    -> PeldrunDiagram
//   ```chart      -> PeldrunChartBlock
//   ```text       -> PeldrunPlainText
//   ```<language> -> CodeBlock
//   no tag        -> PeldrunPlainText
//
// LaTeX:
//   \[...\] and \(...\) delimiters are normalized to the $$...$$ and $...$
//   forms that remark-math v5+ recognizes. KaTeX is configured with
//   strict: "ignore" to suppress false-positive warnings on patterns such
//   as "12.4\%" at the end of inline math.

"use client";

import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

import { CodeBlock } from "@/components/chat/code-block";
import { ImageGallery } from "@/components/chat/ImageGallery";
import { useGenerativeUIStore } from "@/components/generative-ui/store";
import { PeldrunDiagram } from "@/components/generative-ui/catalog/PeldrunDiagram";
import { PeldrunChartBlock } from "@/components/generative-ui/catalog/PeldrunChartBlock";
import { PeldrunPlainText } from "@/components/generative-ui/catalog/PeldrunPlainText";
// v3: UI cards. `PeldrunCardBlock` renders a ```ui fenced JSON block;
// `CardRuntimeContext` carries the image resolvers and prompt handler
// that the block consumes. `buildGalleryIndex` / `normalizeQueryKey`
// build the byRef/byQuery lookup tables from the persisted
// ```image_gallery block, so `image.ref` and `image.query` resolve
// without extra network round-trips (and survive page refresh).
import {
  PeldrunCardBlock,
  CardRuntimeContext,
} from "@/components/generative-ui/catalog/PeldrunCardBlock";
import {
  buildGalleryIndex,
  normalizeQueryKey,
} from "@/components/generative-ui/catalog/galleryRefs";

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface MarkdownRendererProps {
  content: string;
  className?: string;
  /**
   * v3: Callback invoked when the user clicks a "prompt" action on a
   * ```ui card. Receives the raw prompt string the model put on the
   * action. When omitted, prompt-only card actions are hidden; `href`
   * actions still open the link. The parent typically wires this to
   * the chat composer's submit handler.
   */
  onSendPrompt?: (prompt: string) => void;
}

// ---------------------------------------------------------------------------
// Content preprocessing
// ---------------------------------------------------------------------------

/**
 * Normalizes LaTeX delimiters emitted by LLMs.
 *
 * remark-math v5+ only recognizes $...$ (inline) and $$...$$ (display).
 * Legacy LaTeX delimiters \(...\) and \[...\] are translated into the
 * dollar-based forms so KaTeX can render them.
 */
function normalizeMathDelimiters(source: string): string {
  if (!source) return source;

  return source
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$${body}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body}$`);
}

/**
 * Ensures that a GFM table is preceded by a blank line.
 *
 * The raw regex can over-match when a pipe-delimited sequence appears
 * inside a fenced code block (for example a Python bitwise OR followed
 * by a Markdown-looking comment), so the source is split around fenced
 * blocks first and only the prose segments are normalized. Odd indices
 * hold the fenced code segments and are left untouched.
 */
function normalizeMarkdownTables(source: string): string {
  if (!source) return source;

  const segments = source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);

  return segments
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment;
      }

      return segment.replace(
        /([^\n])\n(\s*\|[^\n]+\|\s*\n\s*\|[\s\-:|]+\|)/g,
        "$1\n\n$2"
      );
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Code block language detection
// ---------------------------------------------------------------------------

function canonicalizeLanguage(raw: string | undefined): string {
  if (!raw) return "";
  const lower = raw.toLowerCase().trim();
  const aliases: Record<string, string> = {
    mermaid: "mermaid",
    mmd: "mermaid",
    chart: "chart",
    json_chart: "chart",
    text: "text",
    plaintext: "text",
    plain: "text",
    pre: "text",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rb: "ruby",
    yml: "yaml",
  };
  return aliases[lower] ?? lower;
}

// ---------------------------------------------------------------------------
// Inner component (unexported, memoized below)
// ---------------------------------------------------------------------------

function MarkdownRendererInner({
  content,
  className = "",
  onSendPrompt,
}: MarkdownRendererProps): React.JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const features = useGenerativeUIStore((s) => s.features);
  const enabled = useGenerativeUIStore((s) => s.enabled);

  useEffect(() => {
    setMounted(true);
  }, []);

  // v3: lookup tables for the current message. Both are rebuilt only
  // when `content` changes, so re-renders caused by the elapsed-timer
  // in the chat container do not re-parse the gallery block.
  const galleryIndex = useMemo(() => buildGalleryIndex(content), [content]);

  // v3: runtime handed to every PeldrunCardBlock. `sendPrompt` is
  // optional; when the host does not supply it, prompt-only actions
  // are hidden by the block (see PeldrunCardBlock.UiCard). Image
  // resolvers fall back to `null` when a ref/query is unknown, and
  // the block degrades gracefully (no image, card still renders).
  const cardRuntime = useMemo(
    () => ({
      resolveImage: (ref: string) => galleryIndex.byRef[ref] ?? null,
      resolveImageByQuery: (q: string) =>
        galleryIndex.byQuery[normalizeQueryKey(q)] ?? null,
      sendPrompt: onSendPrompt,
    }),
    [galleryIndex, onSendPrompt],
  );

  // v3: `cards` and `cards_auto_images` default to FALSE in the
  // pre-mount fallback. An unhydrated first render must never emit card
  // markup that the server-side prompt did not enable. The real values
  // arrive via the store subscription once `mounted` flips true.
  const effectiveFeatures = mounted
    ? features
    : {
        mermaid: true,
        latex: true,
        charts: true,
        code_highlighting: true,
        cards: false,
        cards_auto_images: false,
      };

  const effectiveEnabled = mounted ? enabled : true;

  const processed = useMemo(() => {
    if (!content) return "";
    let out = content;
    if (effectiveEnabled && effectiveFeatures.latex) {
      out = normalizeMathDelimiters(out);
    }
    out = normalizeMarkdownTables(out);
    return out;
  }, [content, effectiveEnabled, effectiveFeatures.latex]);

  const remarkPlugins = useMemo(() => {
    const plugins: any[] = [remarkGfm];
    if (effectiveEnabled && effectiveFeatures.latex) {
      plugins.push(remarkMath);
    }
    return plugins;
  }, [effectiveEnabled, effectiveFeatures.latex]);

  const rehypePlugins = useMemo(() => {
    const plugins: any[] = [];
    if (effectiveEnabled && effectiveFeatures.latex) {
      // Pass KaTeX options explicitly.
      //   strict: "ignore"   -> suppress the "% has no terminating newline"
      //                         false positives on patterns like "12.4\%".
      //   throwOnError: false -> render invalid LaTeX as red text instead
      //                          of throwing an exception.
      //   output: "html"     -> skip MathML generation, roughly halving
      //                          the produced DOM size.
      plugins.push([
        rehypeKatex,
        {
          strict: "ignore",
          throwOnError: false,
          output: "html",
        },
      ]);
    }
    return plugins;
  }, [effectiveEnabled, effectiveFeatures.latex]);

  if (!processed) return null;

  return (
    <div
      className={`prose prose-sm dark:prose-invert max-w-none break-words leading-relaxed text-black ${className}`}
    >
      <CardRuntimeContext.Provider value={cardRuntime}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          code({ node, className: codeClass, children, ...props }: any) {
            const match = /language-(\w+)/.exec(codeClass || "");
            const language = canonicalizeLanguage(match?.[1]);
            const rawCode = String(children).replace(/\n$/, "");
            const parentTag = (node as any)?.tagName;
            const isBlock =
              Boolean(match) ||
              rawCode.includes("\n") ||
              parentTag === "pre";

            if (!isBlock) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded-md bg-inlineCode text-black font-mono text-[11px] border border-border/40 font-normal"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            if (language === "mermaid") {
              if (effectiveEnabled && effectiveFeatures.mermaid) {
                return <PeldrunDiagram code={rawCode} />;
              }
              return <CodeBlock code={rawCode} language="text" />;
            }

            if (language === "chart") {
              if (effectiveEnabled && effectiveFeatures.charts) {
                return <PeldrunChartBlock source={rawCode} />;
              }
              return <CodeBlock code={rawCode} language="json" />;
            }

            // v3: ```ui blocks. The model emits these only when the
            // `cards` feature is enabled server-side; the client mirrors
            // the gate so a stale prompt never renders cards the user
            // disabled. When the feature is off, the raw JSON is shown as
            // a plain code block so no content is silently dropped.
            if (language === "ui") {
              if (effectiveEnabled && effectiveFeatures.cards) {
                return <PeldrunCardBlock source={rawCode} />;
              }
              return <CodeBlock code={rawCode} language="json" />;
            }

            // Special block emitted by use-sse-stream in chat mode.
            // The backend's structured image_results payload is
            // embedded as JSON inside this fenced block, and we
            // render it as an inline gallery. Parse failures fall
            // back to plain code (never crash the renderer).
            if (language === "image_gallery") {
              try {
                const parsed = JSON.parse(rawCode);
                // v3: when the model used `image.ref` (or the backend
                // resolved `image.query`) inside ```ui cards, the
                // dispatcher sets `used_in_cards: true` on the gallery
                // payload. In that case the inline gallery is hidden
                // and the pictures appear inside the card layouts
                // instead. The `byRef`/`byQuery` tables are still
                // built by the `galleryIndex` memo above, so the cards
                // can resolve them.
                if (
                  parsed?.used_in_cards &&
                  effectiveEnabled &&
                  effectiveFeatures.cards
                ) {
                  return null;
                }
                const images = Array.isArray(parsed?.images)
                  ? parsed.images
                  : [];
                if (images.length > 0) {
                  return (
                    <ImageGallery
                      images={images}
                      query={
                        typeof parsed?.query === "string"
                          ? parsed.query
                          : undefined
                      }
                      provider={
                        typeof parsed?.provider === "string"
                          ? parsed.provider
                          : undefined
                      }
                    />
                  );
                }
                return null;
              } catch {
                // Malformed payload — render as plain JSON so the
                // user can still see what went wrong.
                return <CodeBlock code={rawCode} language="json" />;
              }
            }

            if (language === "text" || !language) {
              return <PeldrunPlainText source={rawCode} language={language} />;
            }

            if (effectiveEnabled && effectiveFeatures.code_highlighting) {
              return <CodeBlock code={rawCode} language={language} />;
            }
            return <CodeBlock code={rawCode} language="text" />;
          },

          pre({ children }: any) {
            return <>{children}</>;
          },

          img({ src, alt, title, ...props }: any) {
            // Markdown images emitted with an empty or missing URL
            // (e.g. `![alt]()` or an unresolved reference-style
            // image) would render as `<img src="">`, which browsers
            // treat as a request for the current page and React
            // flags in development. Skip such nodes entirely.
            if (!src) return null;
            return (
              <img
                src={src}
                alt={alt ?? ""}
                title={title}
                loading="lazy"
                className="rounded-md my-2 max-w-full h-auto"
                {...props}
              />
            );
          },

          table({ children }: any) {
            return (
              <div className="my-3 overflow-x-auto rounded-sm border border-border bg-card/60 shadow-peldrun-xs">
                <table className="w-full border-collapse border border-border text-xs text-left">
                  {children}
                </table>
              </div>
            );
          },

          thead({ children }: any) {
            return (
              <thead className="bg-muted/70 text-black font-semibold border-b border-border">
                {children}
              </thead>
            );
          },

          tbody({ children }: any) {
            // The first row of the body should not draw a top border,
            // otherwise it would double up with the thead's bottom
            // border and produce a visually heavy divider.
            return (
              <tbody className="[&>tr:first-child>td]:border-t-0">
                {children}
              </tbody>
            );
          },

          tr({ children }: any) {
            return (
              <tr className="transition-colors hover:bg-muted/30">
                {children}
              </tr>
            );
          },

          th({ children, align, style }: any) {
            // remark-gfm forwards the GFM column alignment (:---, :---:,
            // ---:) through the `align` prop. Fall back to the inline
            // style when the renderer shape changes between versions.
            return (
              <th
                className="px-3.5 py-2 text-sm font-semibold align-top border border-border"
                style={{ textAlign: align ?? style?.textAlign }}
              >
                {children}
              </th>
            );
          },

          td({ children, align, style }: any) {
            return (
              <td
                className="px-3.5 py-2 border border-border text-black/90 text-sm align-top"
                style={{ textAlign: align ?? style?.textAlign }}
              >
                {children}
              </td>
            );
          },

          h1({ children }: any) {
            return (
              <h1 className="text-2xl font-semibold font-heading text-black mt-4 mb-2">
                {children}
              </h1>
            );
          },

          h2({ children }: any) {
            return (
              <h2 className="text-xl font-semibold font-heading text-black mt-3 mb-1.5">
                {children}
              </h2>
            );
          },

          h3({ children }: any) {
            return (
              <h3 className="text-lg font-semibold font-heading text-black mt-2.5 mb-1">
                {children}
              </h3>
            );
          },

          p({ children }: any) {
            return <p className="mb-2 leading-relaxed text-sm">{children}</p>;
          },

          ul({ children }: any) {
            return (
              <ul className="list-disc list-inside mb-2 space-y-1 text-sm">
                {children}
              </ul>
            );
          },

          ol({ children }: any) {
            return (
              <ol className="list-decimal list-inside mb-2 space-y-1 text-sm">
                {children}
              </ol>
            );
          },

          blockquote({ children }: any) {
            return (
              <blockquote className="border-l-2 border-primary/60 pl-3 my-2 text-sm text-muted-foreground italic bg-muted/20 py-1 rounded-r-md">
                {children}
              </blockquote>
            );
          },

          a({ href, children, ...props }: any) {
            if (!href) return <a {...props}>{children}</a>;

            let hostname = "";
            let displayLabel = children;
            const textContent = typeof children === "string" ? children : "";

            try {
              const parsedUrl = new URL(href);
              hostname = parsedUrl.hostname;

              if (
                textContent.startsWith("http://") ||
                textContent.startsWith("https://") ||
                textContent === href
              ) {
                displayLabel = (
                  parsedUrl.hostname +
                  parsedUrl.pathname +
                  parsedUrl.search
                ).replace(/\/$/, "");
              }
            } catch {
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary text-[12px] hover:underline font-medium transition-all"
                  {...props}
                >
                  {children}
                </a>
              );
            }

            const faviconUrl = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;

            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 my-0.5 rounded-md bg-muted/60 hover:bg-muted text-primary hover:underline font-mono text-[10px] font-medium transition-all border border-border/50 align-baseline max-w-full"
                title={href}
                {...props}
              >
                {hostname ? (
                  <img
                    src={faviconUrl}
                    alt=""
                    width={13}
                    height={13}
                    referrerPolicy="no-referrer"
                    className="w-3.5 h-3.5 shrink-0 rounded-xs inline-block"
                    onError={(e) => {
                      (e.currentTarget as HTMLElement).style.display = "none";
                    }}
                  />
                ) : null}
                <span className="truncate max-w-[280px]">{displayLabel}</span>
              </a>
            );
          },
        }}
      >
        {processed}
      </ReactMarkdown>
      </CardRuntimeContext.Provider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memoized export
// ---------------------------------------------------------------------------

/**
 * Custom comparator.
 *
 * Only re-render when the message content or the layout class changes.
 * Feature flags are read from the store *inside* the component, so an
 * external change to them will still reach the component via its own
 * subscription — the comparator does not need to inspect them.
 *
 * This is the single most important performance guard in the chat view:
 * without it, the elapsed-timer tick that fires once per second re-runs
 * KaTeX on every message in the conversation.
 */
function markdownRendererPropsAreEqual(
  prev: MarkdownRendererProps,
  next: MarkdownRendererProps
): boolean {
  return (
    prev.content === next.content && prev.className === next.className
  );
}

export const MarkdownRenderer = React.memo(
  MarkdownRendererInner,
  markdownRendererPropsAreEqual
);

MarkdownRenderer.displayName = "MarkdownRenderer";

export default MarkdownRenderer;
