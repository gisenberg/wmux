/**
 * Native clients may provide useful long names. Keep the stored value bounded
 * independently from the shorter text that chrome can reasonably present.
 */
export const MAX_TITLE_UTF16_LENGTH = 4_096;
export const MAX_TITLE_GRAPHEME_COUNT = 512;
export const MAX_TITLE_DISPLAY_GRAPHEME_COUNT = 80;

const controlCharacter = /[\x00-\x1f\x7f-\x9f]/;

const graphemes = (value: string): string[] | undefined => {
  const Segmenter = Intl.Segmenter;
  if (!Segmenter) return undefined;
  return Array.from(new Segmenter().segment(value), (part) => part.segment);
};

const safelyBoundWithoutSegmenter = (value: string): boolean =>
  value.length <= MAX_TITLE_UTF16_LENGTH
  // Code-point count is an upper bound for grapheme count, so this may reject
  // some otherwise-valid combining text but never admits an unbounded title.
  && Array.from(value).length <= MAX_TITLE_GRAPHEME_COUNT;

export const isValidTitle = (value: unknown): value is string =>
  typeof value === "string"
  && value.length <= MAX_TITLE_UTF16_LENGTH
  && (graphemes(value)?.length ?? Array.from(value).length) <= MAX_TITLE_GRAPHEME_COUNT
  && Boolean(value.trim())
  && !controlCharacter.test(value);

/** A grapheme-safe display label. Callers retain the original title for aria-label/title. */
export const displayTitle = (
  value: string,
  maximum = MAX_TITLE_DISPLAY_GRAPHEME_COUNT,
): string => {
  const parts = graphemes(value);
  // Do not risk splitting a combining sequence on runtimes without Segmenter.
  // CSS can still clip the full string visually; accessibility retains it too.
  if (!parts) return value;
  return parts.length <= maximum ? value : `${parts.slice(0, maximum).join("")}…`;
};

/** Defensive storage bound for non-HTTP callers after they have cleaned a title. */
export const boundTitle = (value: string): string => {
  const parts = graphemes(value);
  if (!parts) return safelyBoundWithoutSegmenter(value) ? value : "";
  const result: string[] = [];
  let utf16Length = 0;
  for (const grapheme of parts) {
    if (result.length === MAX_TITLE_GRAPHEME_COUNT || utf16Length + grapheme.length > MAX_TITLE_UTF16_LENGTH) break;
    result.push(grapheme);
    utf16Length += grapheme.length;
  }
  return result.join("");
};
