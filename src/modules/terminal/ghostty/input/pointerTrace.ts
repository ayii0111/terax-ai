import { invoke } from "@tauri-apps/api/core";

/**
 * Temporary trace for the sticky-drag bug: plain hover acting as a drag in one tab.
 * Records what WebKit delivered (window capture) next to what the pane controllers did, so a
 * lost release can be told apart from stale `buttons`. Never records typed text; the only keys
 * recorded are Cmd+C and the marker chord.
 * Written to `pointer-trace.log` in the app log directory. Remove once the bug is resolved.
 */
type TraceFields = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

const FLUSH_DELAY_MS = 1000;
const MAX_PENDING_LINES = 4000;

const panes = new WeakMap<object, number>();
let enabled = false;
let composing = false;
let pending: string[] = [];
let dropped = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function formatTraceLine(
  time: Date,
  event: string,
  fields: TraceFields,
): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const stamp =
    `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}` +
    `T${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}` +
    `.${pad(time.getMilliseconds(), 3)}`;
  const values = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return [stamp, event, ...values].join(" ");
}

/** Reduces a stream of moves to its changes: the moves folded since the last change, or null. */
export class MotionCoalescer {
  private signature: string | null = null;
  private folded = 0;

  observe(signature: string): number | null {
    if (signature === this.signature) {
      this.folded += 1;
      return null;
    }
    const folded = this.folded;
    this.signature = signature;
    this.folded = 0;
    return folded;
  }

  takeFolded(): number {
    const folded = this.folded;
    this.folded = 0;
    return folded;
  }
}

export function tracePointer(event: string, fields: TraceFields = {}): void {
  if (!enabled) return;
  if (pending.length >= MAX_PENDING_LINES) {
    dropped += 1;
    return;
  }
  pending.push(formatTraceLine(new Date(), event, fields));
  flushTimer ??= setTimeout(flushPointerTrace, FLUSH_DELAY_MS);
}

export function tracePane(target: object, leafId: number): void {
  panes.set(target, leafId);
  tracePointer("pane-attach", { leaf: leafId });
}

export function tracePaneLabel(target: object): number | "?" {
  return panes.get(target) ?? "?";
}

export function flushPointerTrace(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  if (pending.length === 0) return;
  if (dropped > 0) {
    pending.push(formatTraceLine(new Date(), "trace-dropped", { dropped }));
    dropped = 0;
  }
  const lines = `${pending.join("\n")}\n`;
  pending = [];
  void invoke("pointer_trace_append", { lines }).catch(() => {});
}

function describeTarget(target: EventTarget | null): {
  target: string;
  leaf?: number;
} {
  if (!(target instanceof Element)) {
    return { target: target === window ? "window" : "document" };
  }
  const name = target.classList[0];
  let leaf: number | undefined;
  for (
    let node: Element | null = target;
    node && leaf === undefined;
    node = node.parentElement
  ) {
    leaf = panes.get(node);
  }
  return {
    target: `${target.tagName.toLowerCase()}${name ? `.${name}` : ""}`,
    leaf,
  };
}

/** Ctrl+Option+Cmd+M writes a marker, so the moment the bug was noticed is easy to find. */
function isMarkChord(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey && event.altKey && event.metaKey && event.code === "KeyM"
  );
}

export function installPointerTrace(): void {
  if (enabled) return;
  enabled = true;
  const options = { capture: true, passive: true };
  const motion = new MotionCoalescer();
  let lastButtons = 0;
  let lastKeyAt = 0;

  for (const type of [
    "pointerdown",
    "pointerup",
    "pointercancel",
    "mousedown",
    "mouseup",
    "click",
    "dragstart",
    "contextmenu",
  ]) {
    window.addEventListener(
      type,
      (event) => {
        const mouse = event as MouseEvent;
        tracePointer(`dom:${type}`, {
          ...describeTarget(event.target),
          button: mouse.button,
          buttons: mouse.buttons,
          x: Math.round(mouse.clientX),
          y: Math.round(mouse.clientY),
          shift: mouse.shiftKey,
          composing,
          sinceKeyMs: Math.round(performance.now() - lastKeyAt),
          focus: describeTarget(document.activeElement).leaf,
        });
      },
      options,
    );
  }

  window.addEventListener(
    "pointermove",
    (event) => {
      const folded = motion.observe(String(event.buttons));
      if (folded === null) return;
      tracePointer("dom:pointermove", {
        ...describeTarget(event.target),
        buttons: event.buttons,
        previous: lastButtons,
        folded,
      });
      lastButtons = event.buttons;
    },
    options,
  );

  for (const type of ["focus", "blur"]) {
    window.addEventListener(
      type,
      (event) => tracePointer(`dom:${type}`, describeTarget(event.target)),
      options,
    );
  }
  document.addEventListener("visibilitychange", () =>
    tracePointer("dom:visibilitychange", { state: document.visibilityState }),
  );
  for (const type of ["compositionstart", "compositionend"]) {
    window.addEventListener(
      type,
      (event) => {
        composing = type === "compositionstart";
        tracePointer(`dom:${type}`, describeTarget(event.target));
      },
      options,
    );
  }
  window.addEventListener(
    "keydown",
    (event) => {
      lastKeyAt = performance.now();
      if (event.metaKey && event.code === "KeyC") {
        tracePointer("dom:cmd-c", {
          ...describeTarget(document.activeElement),
          buttons: lastButtons,
          composing,
        });
      }
      if (!isMarkChord(event)) return;
      tracePointer("USER-MARK", {
        buttons: lastButtons,
        folded: motion.takeFolded(),
        focus: describeTarget(document.activeElement).leaf,
        composing,
      });
      flushPointerTrace();
    },
    options,
  );
  window.addEventListener("pagehide", flushPointerTrace, options);
  tracePointer("trace-start", { ua: navigator.userAgent.replace(/\s/g, "_") });
}
