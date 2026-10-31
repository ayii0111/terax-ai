import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
} from "@codemirror/lang-markdown";
import {
  type ChangeSpec,
  Prec,
  type StateCommand,
  type Transaction,
} from "@codemirror/state";
import { keymap } from "@codemirror/view";

// An empty item ends the list instead of turning a tight list loose.
const continueMarkup = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});

// A line break, then a line holding only indentation or quote marks, then
// the break before the continued markup.
const LOOSE_GAP = /^(\r?\n)[ \t>]*\r?\n/;

/**
 * Enter in Markdown: continues list and quote markup on the next line. Unlike
 * CodeMirror's command it never adds a blank line to keep a loose list loose,
 * so the new item always sits directly under the current one.
 */
export const insertNewlineContinueTightMarkup: StateCommand = ({
  state,
  dispatch,
}) =>
  continueMarkup({
    state,
    dispatch: (tr) => dispatch(withoutLooseGap(tr) ?? tr),
  });

function withoutLooseGap(tr: Transaction): Transaction | null {
  const changes: ChangeSpec[] = [];
  let tightened = false;
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    let insert = inserted.toString();
    const gap = LOOSE_GAP.exec(insert);
    if (gap) {
      insert = gap[1] + insert.slice(gap[0].length);
      tightened = true;
    }
    changes.push({ from, to, insert });
  });
  if (!tightened) return null;
  const start = tr.startState;
  const changeSet = start.changes(changes);
  return start.update({
    changes: changeSet,
    selection: start.selection.map(changeSet, 1),
    scrollIntoView: true,
    userEvent: "input",
  });
}

/** Replaces `markdown()`'s default keymap (create it with `addKeymap: false`). */
export function markdownKeymap() {
  return Prec.high(
    keymap.of([
      { key: "Enter", run: insertNewlineContinueTightMarkup },
      { key: "Backspace", run: deleteMarkupBackward },
    ]),
  );
}
