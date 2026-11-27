// frontend/src/components/generative-ui/catalog/galleryRefs.ts
//
// Builds lookup tables for ONE message from the ```image_gallery block the
// dispatcher embeds in the persisted result text:
//   byRef   : "img_<n>"            -> proxied image URL
//   byQuery : normalized image.query -> proxied image URL
//
// Both survive a page refresh because the block is part of the message text.
//
// Contract with the backend:
//   * img_<n> is the 1-based index into the gallery `images` array.
//   * `query_map` maps normalizeQueryKey(query) -> 1-based index.
//   * normalizeQueryKey MUST match normalize_query_key() in card_images.py.

export function normalizeQueryKey(query: string): string {
  return String(query ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface GalleryIndex {
  byRef: Record<string, string>;
  byQuery: Record<string, string>;
}

export function buildGalleryIndex(content: string): GalleryIndex {
  const index: GalleryIndex = { byRef: {}, byQuery: {} };
  if (!content || !content.includes("image_gallery")) return index;

  const re = /```image_gallery\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (!Array.isArray(parsed?.images)) continue;
      const urlAt = (i: number): string | undefined => {
        const u = (parsed.images[i - 1] as { image_url?: unknown } | undefined)?.image_url;
        return typeof u === "string" && u ? u : undefined;
      };
      for (let i = 1; i <= parsed.images.length; i++) {
        const u = urlAt(i);
        if (u) index.byRef[`img_${i}`] = u;
      }
      const qm = parsed.query_map;
      if (qm && typeof qm === "object") {
        for (const [key, idx] of Object.entries(qm)) {
          const u = typeof idx === "number" ? urlAt(idx) : undefined;
          if (u) index.byQuery[key] = u;
        }
      }
    } catch {
      /* malformed or still streaming: ignore */
    }
  }
  return index;
}
