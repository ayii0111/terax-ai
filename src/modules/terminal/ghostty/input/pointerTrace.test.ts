import { describe, expect, it } from "vitest";
import { formatTraceLine, MotionCoalescer } from "./pointerTrace";

describe("pointer trace", () => {
  it("formats a local timestamp and omits undefined fields", () => {
    expect(
      formatTraceLine(new Date(2026, 9, 31, 7, 8, 9, 5), "dom:mouseup", {
        leaf: 3,
        buttons: 0,
        shift: false,
        focus: undefined,
      }),
    ).toBe("2026-10-31T07:08:09.005 dom:mouseup leaf=3 buttons=0 shift=false");
  });

  it("reports only signature changes with the moves folded before them", () => {
    const motion = new MotionCoalescer();
    expect(motion.observe("0")).toBe(0);
    expect(motion.observe("0")).toBeNull();
    expect(motion.observe("0")).toBeNull();
    expect(motion.observe("1")).toBe(2);
    expect(motion.observe("1")).toBeNull();
    expect(motion.takeFolded()).toBe(1);
    expect(motion.observe("0")).toBe(0);
  });
});
