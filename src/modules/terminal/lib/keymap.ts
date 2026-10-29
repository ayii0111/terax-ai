export type TerminalKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "key" | "code"
>;

export type PlatformOpts = { isMac: boolean };

export function terminalWordNavigationSequence(event: TerminalKeyEvent): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "ArrowLeft" || event.code === "ArrowLeft") return "\x1bb";
  if (event.key === "ArrowRight" || event.code === "ArrowRight") return "\x1bf";
  return null;
}

/** Cmd+Left/Right → readline line-start (Ctrl+A) / line-end (Ctrl+E).
 * macOS-only — Cmd doesn't exist as a navigation modifier elsewhere. */
export function terminalLineNavigationSequence(
  event: TerminalKeyEvent,
  opts: PlatformOpts,
): string | null {
  if (!opts.isMac) return null;
  if (!event.metaKey || event.altKey || event.ctrlKey) return null;
  if (event.key === "ArrowLeft" || event.code === "ArrowLeft") return "\x01";
  if (event.key === "ArrowRight" || event.code === "ArrowRight") return "\x05";
  return null;
}

/** Option+Z → readline undo (Ctrl+_). macOS-only: Option+letter normally
 * types a symbol there ("Ω"), so check event.code rather than event.key. */
export function terminalUndoSequence(
  event: TerminalKeyEvent,
  opts: PlatformOpts,
): string | null {
  if (!opts.isMac) return null;
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.code === "KeyZ") return "\x1f";
  return null;
}

/** Modifier+Backspace deletion:
 *   macOS  Cmd+Backspace    → Ctrl+U (kill-to-line-start)
 *   macOS  Option+Backspace → Ctrl+W (kill-word-backward)
 *   Other  Ctrl+Backspace   → Ctrl+W (kill-word-backward)
 */
export function terminalDeleteSequence(
  event: TerminalKeyEvent,
  opts: PlatformOpts,
): string | null {
  if (event.key !== "Backspace" && event.code !== "Backspace") return null;
  if (opts.isMac) {
    if (event.metaKey && !event.altKey && !event.ctrlKey) return "\x15";
    if (event.altKey && !event.metaKey && !event.ctrlKey) return "\x17";
    return null;
  }
  if (event.ctrlKey && !event.altKey && !event.metaKey) return "\x17";
  return null;
}

/** Applied on the alternate screen too, matching Ghostty's own macOS
 * defaults: TUIs such as Claude Code otherwise never see these chords,
 * because unclaimed Command keys are left to the native menu. */
export function terminalReadlineSequence(
  event: TerminalKeyEvent,
  opts: PlatformOpts,
): string | null {
  return (
    terminalLineNavigationSequence(event, opts) ??
    terminalWordNavigationSequence(event) ??
    terminalDeleteSequence(event, opts) ??
    terminalUndoSequence(event, opts)
  );
}
