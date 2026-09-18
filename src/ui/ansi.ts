export const ESC = "\u001b[";

// Keep colors in the terminal's configurable ANSI palette. Slot 8 is the
// theme-provided muted/bright-black color; unlike reverse video it does not
// turn the terminal's foreground into a glaring, theme-external background.
const terminalPalette = {
  selectionBackground: 8,
} as const;

function background(value: string, paletteIndex: number): string {
  return `${ESC}48;5;${paletteIndex}m${value}${ESC}49m`;
}

export const style = {
  bold: (value: string): string => `${ESC}1m${value}${ESC}22m`,
  dim: (value: string): string => `${ESC}2m${value}${ESC}22m`,
  selection: (value: string): string => background(value, terminalPalette.selectionBackground),
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Remove terminal controls and normalize whitespace from untrusted text. */
export function sanitize(value: unknown): string {
  return String(value ?? "")
    .replace(ansiPattern, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[\r\n\t]/g, " ");
}

export function stripAnsi(value: string): string {
  return value.replace(ansiPattern, "");
}

function graphemeWidth(value: string): number {
  if (!value) return 0;
  const points = [...value].map((character) => character.codePointAt(0) ?? 0);
  if (points.every((point) => point === 0x200d || point === 0xfe0e || point === 0xfe0f || isCombining(point))) return 0;
  if (points.includes(0xfe0f) || points.some(isWide)) return 2;
  return 1;
}

function isCombining(point: number): boolean {
  return (point >= 0x300 && point <= 0x36f) || (point >= 0x1ab0 && point <= 0x1aff)
    || (point >= 0x1dc0 && point <= 0x1dff) || (point >= 0x20d0 && point <= 0x20ff)
    || (point >= 0xfe20 && point <= 0xfe2f);
}

function isWide(point: number): boolean {
  return point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
    || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe19)
    || (point >= 0xfe30 && point <= 0xfe6f)
    || (point >= 0xff00 && point <= 0xff60)
    || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x1f000 && point <= 0x1faff)
    || (point >= 0x20000 && point <= 0x3fffd)
  );
}

export function cellWidth(value: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(stripAnsi(value))) width += graphemeWidth(segment);
  return width;
}

export function truncate(value: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (cellWidth(value) <= width) return value;
  const mark = cellWidth(ellipsis) <= width ? ellipsis : "";
  const available = width - cellWidth(mark);
  let result = "";
  let used = 0;
  let hadAnsi = false;
  for (const token of ansiAndGraphemeTokens(value)) {
    if (token.ansi) { result += token.value; hadAnsi = true; continue; }
    const next = graphemeWidth(token.value);
    if (used + next > available) break;
    result += token.value;
    used += next;
  }
  return result + mark + (hadAnsi ? `${ESC}0m` : "");
}

function ansiAndGraphemeTokens(value: string): Array<{ value: string; ansi: boolean }> {
  const tokens: Array<{ value: string; ansi: boolean }> = [];
  let offset = 0;
  for (const match of value.matchAll(new RegExp(ansiPattern.source, "g"))) {
    const index = match.index;
    if (index > offset) for (const { segment } of segmenter.segment(value.slice(offset, index))) tokens.push({ value: segment, ansi: false });
    tokens.push({ value: match[0], ansi: true });
    offset = index + match[0].length;
  }
  if (offset < value.length) for (const { segment } of segmenter.segment(value.slice(offset))) tokens.push({ value: segment, ansi: false });
  return tokens;
}

export function pad(value: string, width: number): string {
  const clipped = truncate(value, width, "");
  return clipped + " ".repeat(Math.max(0, width - cellWidth(clipped)));
}

export type CursorCell = { readonly row: number; readonly column: number };
export type Frame = {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly string[];
  readonly cursor?: CursorCell;
};

/** Encode a complete, non-scrolling frame. Rows are already renderer-owned ANSI. */
export function encodeFrame(_previous: Frame | undefined, next: Frame): string {
  // A plugin popup owns a fresh viewport, so a clear or alternate-screen
  // transition only creates a visible blank frame on terminals that do not
  // implement synchronized output. Every frame already overwrites every row.
  const prefix = `${ESC}?2026h${ESC}H`;
  // Clear before drawing, not after. Once a row fills the viewport the cursor
  // remains on its final cell with autowrap pending; EL (`CSI K`) would then
  // erase that cell, making the popup's right edge appear clipped. Addressing
  // each row directly also avoids relying on newline behavior at the margin.
  const body = next.rows.slice(0, next.height).map((row, index) =>
    `${index === 0 ? "" : `${ESC}${index + 1};1H`}${ESC}2K${row}`
  ).join("");
  const cursor = next.cursor
    ? `${ESC}${Math.max(1, next.cursor.row + 1)};${Math.max(1, next.cursor.column + 1)}H${ESC}?25h`
    : `${ESC}?25l`;
  return `${prefix}${body}${ESC}0m${cursor}${ESC}?2026l`;
}
