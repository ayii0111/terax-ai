import { describe, expect, it, vi } from "vitest";
import {
  applyTerminalInputAnchor,
  terminalInputAnchor,
} from "./terminalInputAnchor";

const METRICS = {
  font: {
    family: "monospace",
    size: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    weight: "400",
  },
  cellWidth: 8,
  cellHeight: 17,
};
const GRID = { cols: 80, rows: 24 };

function input() {
  const writes = vi.fn();
  const style = new Proxy<Record<string, string>>(
    { pointerEvents: "none" },
    {
      set(target, property: string, value: string) {
        writes(property);
        target[property] = value;
        return true;
      },
    },
  );
  return { field: { style } as unknown as HTMLTextAreaElement, style, writes };
}

describe("terminalInputAnchor", () => {
  it("covers the cursor cell through the end of its row", () => {
    expect(terminalInputAnchor({ x: 10, y: 3 }, GRID, METRICS, 0)).toEqual({
      left: "80px",
      top: "51px",
      width: "560px",
      height: "17px",
      lineHeight: "17px",
      fontSize: "14px",
    });
  });

  it("follows a grid moved up inside its pane", () => {
    expect(terminalInputAnchor({ x: 0, y: 3 }, GRID, METRICS, 17).top).toBe(
      "34px",
    );
    expect(terminalInputAnchor({ x: 0, y: 0 }, GRID, METRICS, 17).top).toBe(
      "0px",
    );
  });

  it("stays on the grid for a cursor outside of it", () => {
    const anchor = terminalInputAnchor({ x: 80, y: 24 }, GRID, METRICS, 0);
    expect(anchor.left).toBe("632px");
    expect(anchor.top).toBe("391px");
    expect(anchor.width).toBe("8px");
    expect(terminalInputAnchor({ x: -1, y: -1 }, GRID, METRICS, 0).left).toBe(
      "0px",
    );
  });
});

describe("applyTerminalInputAnchor", () => {
  it("moves the field onto the anchor", () => {
    const { field, style } = input();
    applyTerminalInputAnchor(
      field,
      terminalInputAnchor({ x: 2, y: 1 }, GRID, METRICS, 0),
    );
    expect(style.left).toBe("16px");
    expect(style.top).toBe("17px");
    expect(style.width).toBe("624px");
    expect(style.height).toBe("17px");
  });

  it("writes nothing for an unchanged anchor", () => {
    const { field, writes } = input();
    const anchor = terminalInputAnchor({ x: 2, y: 1 }, GRID, METRICS, 0);
    applyTerminalInputAnchor(field, anchor);
    writes.mockClear();
    applyTerminalInputAnchor(field, anchor);
    expect(writes).not.toHaveBeenCalled();
  });

  it("leaves a field lent to the native context menu alone", () => {
    const { field, style, writes } = input();
    style.pointerEvents = "auto";
    writes.mockClear();
    applyTerminalInputAnchor(
      field,
      terminalInputAnchor({ x: 2, y: 1 }, GRID, METRICS, 0),
    );
    expect(writes).not.toHaveBeenCalled();
  });
});
