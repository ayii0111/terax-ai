/**
 * Ends a drag when a non-modifier key is pressed during it, as WebKit's native text selection
 * does. Three-finger drag on a macOS trackpad keeps reporting the left button as held after such a
 * key press, until the next tap. Every drag implemented in script (terminal selection, CodeMirror,
 * tab reordering) follows `MouseEvent.buttons`, so plain hover would keep extending it.
 *
 * Cancelling instead of releasing keeps a drag from committing (a tab drop, a file move); `mouseup`
 * is still sent because CodeMirror and terminal mouse reporting only end on it.
 */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

export function isDragEndingKey(event: Pick<KeyboardEvent, "key">): boolean {
  return !MODIFIER_KEYS.has(event.key);
}

type PointerSample = Pick<
  PointerEvent,
  "button" | "clientX" | "clientY" | "pointerId" | "target"
>;

export type HeldPointer = {
  readonly target: EventTarget | null;
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
};

/** The left-button press in progress, kept from its pointerdown to its end. */
export class HeldPointerTracker {
  private held: HeldPointer | null = null;

  press(event: PointerSample): void {
    if (event.button !== 0) return;
    this.held = {
      target: event.target,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    };
  }

  move(event: Pick<PointerEvent, "clientX" | "clientY" | "pointerId">): void {
    if (this.held?.pointerId !== event.pointerId) return;
    this.held = {
      ...this.held,
      clientX: event.clientX,
      clientY: event.clientY,
    };
  }

  release(event: Pick<PointerEvent, "pointerId">): void {
    if (this.held?.pointerId === event.pointerId) this.held = null;
  }

  /** The press a key should end, which then counts as over. */
  takeForKey(event: Pick<KeyboardEvent, "key">): HeldPointer | null {
    if (!isDragEndingKey(event)) return null;
    const held = this.held;
    this.held = null;
    return held;
  }
}

function endDrag(held: HeldPointer): void {
  const target =
    held.target instanceof Node && held.target.isConnected
      ? held.target
      : document;
  const position = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: held.clientX,
    clientY: held.clientY,
    button: 0,
    buttons: 0,
  };
  target.dispatchEvent(
    new PointerEvent("pointercancel", {
      ...position,
      pointerId: held.pointerId,
      isPrimary: true,
    }),
  );
  target.dispatchEvent(new MouseEvent("mouseup", position));
}

/** Install before the app renders, so this runs ahead of shortcuts that stop the key event. */
export function installDragKeyGuard(onEnded?: () => void): void {
  const tracker = new HeldPointerTracker();
  const options = { capture: true, passive: true };
  window.addEventListener(
    "pointerdown",
    (event) => tracker.press(event),
    options,
  );
  window.addEventListener(
    "pointermove",
    (event) => tracker.move(event),
    options,
  );
  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(
      type,
      (event) => tracker.release(event as PointerEvent),
      options,
    );
  }
  window.addEventListener(
    "keydown",
    (event) => {
      const held = tracker.takeForKey(event);
      if (!held) return;
      onEnded?.();
      endDrag(held);
    },
    options,
  );
}
