import { describe, expect, it } from "vitest";
import { pickAdjacentTab, type Tab } from "./useTabs";

function term(id: number, spaceId: string): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
  } as Tab;
}

describe("pickAdjacentTab", () => {
  const tabs = [
    term(1, "a"),
    term(2, "b"),
    term(3, "a"),
    term(4, "b"),
    term(5, "a"),
  ];

  it("moves right in strip order, skipping other spaces", () => {
    expect(pickAdjacentTab(tabs, 1, 1, "a")?.id).toBe(3);
  });

  it("moves left in strip order, skipping other spaces", () => {
    expect(pickAdjacentTab(tabs, 5, -1, "a")?.id).toBe(3);
  });

  it("wraps from the last tab to the first", () => {
    expect(pickAdjacentTab(tabs, 5, 1, "a")?.id).toBe(1);
  });

  it("wraps from the first tab to the last", () => {
    expect(pickAdjacentTab(tabs, 1, -1, "a")?.id).toBe(5);
  });

  it("does nothing when the space has only one tab", () => {
    expect(pickAdjacentTab([term(1, "a")], 1, 1, "a")).toBeUndefined();
  });

  it("does nothing when the active tab isn't in the space", () => {
    expect(pickAdjacentTab(tabs, 2, 1, "a")).toBeUndefined();
  });
});
