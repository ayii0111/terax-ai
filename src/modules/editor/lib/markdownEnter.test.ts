import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { insertNewlineContinueTightMarkup } from "./markdownEnter";

/** Presses Enter `times` at the end of `doc` (or at `|`) and returns the text, `|` marking the cursor. */
function enter(doc: string, times = 1): string {
  const cursor = doc.includes("|") ? doc.indexOf("|") : doc.length;
  let state = EditorState.create({
    doc: doc.replace("|", ""),
    selection: { anchor: cursor },
    extensions: [markdown({ base: markdownLanguage, addKeymap: false })],
  });
  for (let index = 0; index < times; index += 1) {
    ensureSyntaxTree(state, state.doc.length, 5000);
    insertNewlineContinueTightMarkup({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
  }
  const head = state.selection.main.head;
  const text = state.doc.toString();
  return `${text.slice(0, head)}|${text.slice(head)}`;
}

describe("insertNewlineContinueTightMarkup", () => {
  it("continues a tight list directly under the current item", () => {
    expect(enter("- a\n- b")).toBe("- a\n- b\n- |");
    expect(enter("1. a\n2. b")).toBe("1. a\n2. b\n3. |");
  });

  it("does not add a blank line inside a loose list", () => {
    expect(enter("- a\n\n- b")).toBe("- a\n\n- b\n- |");
    expect(enter("- x\n  - a\n\n  - b")).toBe("- x\n  - a\n\n  - b\n  - |");
  });

  it("ends the list on an empty second item instead of making it loose", () => {
    expect(enter("- a", 2)).toBe("- a\n|");
    expect(enter("- a\n- ")).toBe("- a\n|");
  });

  it("keeps continuing quotes and splitting items mid-line", () => {
    expect(enter("> quote")).toBe("> quote\n> |");
    expect(enter("- ab|cd")).toBe("- ab\n- |cd");
  });
});
