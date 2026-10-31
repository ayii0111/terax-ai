import { describe, expect, it } from "vitest";
import { HeldPointerTracker, isDragEndingKey } from "./dragKeyGuard";

const target = {} as EventTarget;
const pointer = (clientX: number, button = 0, pointerId = 1) => ({
  button,
  clientX,
  clientY: 20,
  pointerId,
  target,
});

describe("drag key guard", () => {
  it("treats every key but a modifier as ending a drag", () => {
    for (const key of ["c", ";", "F6", "Enter", "Escape", "Process", "Dead"]) {
      expect(isDragEndingKey({ key })).toBe(true);
    }
    for (const key of ["Meta", "Shift", "Alt", "Control", "CapsLock", "Fn"]) {
      expect(isDragEndingKey({ key })).toBe(false);
    }
  });

  it("ends a held press once, at the latest pointer position", () => {
    const tracker = new HeldPointerTracker();
    tracker.press(pointer(10));
    tracker.move(pointer(30));
    expect(tracker.takeForKey({ key: "F6" })).toEqual({
      target,
      pointerId: 1,
      clientX: 30,
      clientY: 20,
    });
    expect(tracker.takeForKey({ key: "F6" })).toBeNull();
  });

  it("keeps the drag through a modifier press", () => {
    const tracker = new HeldPointerTracker();
    tracker.press(pointer(10));
    expect(tracker.takeForKey({ key: "Meta" })).toBeNull();
    expect(tracker.takeForKey({ key: "c" })).not.toBeNull();
  });

  it("has nothing to end after a release, or for other buttons and pointers", () => {
    const tracker = new HeldPointerTracker();
    expect(tracker.takeForKey({ key: "a" })).toBeNull();
    tracker.press(pointer(10));
    tracker.release({ pointerId: 1 });
    expect(tracker.takeForKey({ key: "a" })).toBeNull();
    tracker.press(pointer(10, 2));
    expect(tracker.takeForKey({ key: "a" })).toBeNull();
    tracker.press(pointer(10));
    tracker.release({ pointerId: 2 });
    tracker.move(pointer(99, 0, 2));
    expect(tracker.takeForKey({ key: "a" })?.clientX).toBe(10);
  });
});
