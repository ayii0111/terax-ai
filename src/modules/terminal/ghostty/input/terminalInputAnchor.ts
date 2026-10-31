import type { TerminalFontMetrics } from "../gpu/terminalVisuals";

/**
 * The system places an IME's composition and candidate windows from the rectangle of the focused
 * field's text, so the terminal's hidden input has to sit on the cursor cell. The field reaches
 * the end of the row: composition text then stays unscrolled and those windows follow it.
 */
export const TERMINAL_INPUT_STYLE =
  "position:absolute;left:0;top:0;width:1px;height:1px;margin:0;padding:0;border:0;overflow:hidden;white-space:pre;opacity:0;resize:none;pointer-events:none;";

export type TerminalInputAnchor = {
  readonly left: string;
  readonly top: string;
  readonly width: string;
  readonly height: string;
  readonly lineHeight: string;
  readonly fontSize: string;
};

/**
 * @param shiftY CSS pixels the drawn grid is moved up inside the pane.
 */
export function terminalInputAnchor(
  cursor: { readonly x: number; readonly y: number },
  grid: { readonly cols: number; readonly rows: number },
  metrics: Pick<TerminalFontMetrics, "font" | "cellWidth" | "cellHeight">,
  shiftY: number,
): TerminalInputAnchor {
  const column = Math.min(Math.max(0, cursor.x), Math.max(0, grid.cols - 1));
  const row = Math.min(Math.max(0, cursor.y), Math.max(0, grid.rows - 1));
  const height = `${metrics.cellHeight}px`;
  return {
    left: `${column * metrics.cellWidth}px`,
    top: `${Math.max(0, row * metrics.cellHeight - shiftY)}px`,
    width: `${Math.max(1, grid.cols - column) * metrics.cellWidth}px`,
    height,
    lineHeight: height,
    fontSize: `${metrics.font.size}px`,
  };
}

/** Writes only what changed, and leaves a field lent to the native context menu alone. */
export function applyTerminalInputAnchor(
  input: HTMLTextAreaElement,
  anchor: TerminalInputAnchor,
): void {
  const { style } = input;
  if (style.pointerEvents === "auto") return;
  if (style.left !== anchor.left) style.left = anchor.left;
  if (style.top !== anchor.top) style.top = anchor.top;
  if (style.width !== anchor.width) style.width = anchor.width;
  if (style.height !== anchor.height) style.height = anchor.height;
  if (style.lineHeight !== anchor.lineHeight)
    style.lineHeight = anchor.lineHeight;
  if (style.fontSize !== anchor.fontSize) style.fontSize = anchor.fontSize;
}
