import assert from "node:assert/strict";
import test from "node:test";
import type { WorktreeInventory } from "../src/core/domain.js";
import { cellWidth, stripAnsi } from "../src/ui/ansi.js";
import { initialState, type ManagerState } from "../src/ui/model.js";
import { render } from "../src/ui/view.js";

function state(width: number, height: number): ManagerState {
  const inventory: WorktreeInventory = {
    root: { path: "/repo", commonDirectory: "/repo/.bare", name: "bad\u001b[2Jrepo" },
    worktrees: Array.from({ length: 15 }, (_, index) => ({
      path: `/repo/topic-${index}`, localDirectory: index === 7 ? "界e\u0301" : `topic-${index}`,
      head: "abcdef1234567890", branch: `branch-${index}`, isDetached: false, isCurrent: index === 0,
      status: index === 1 ? { kind: "dirty" as const, changedFileCount: 2 } : index === 2 ? { kind: "unavailable" as const, reason: "bad" } : { kind: "clean" as const },
    })),
  };
  return { ...initialState({ width, height }, "/repo"), inventory, selected: 7, selectedPath: "/repo/topic-7", operation: "idle", message: "Ready", statusToken: 1 };
}

for (const [width, height] of [[100, 24], [87, 18], [20, 5], [1, 1]] as const) {
  test(`renders an exact ${width}x${height} frame`, () => {
    const frame = render(state(width, height));
    assert.equal(frame.rows.length, height);
    for (const row of frame.rows) assert.equal(cellWidth(row), width);
    assert.doesNotMatch(frame.rows.join(""), /\u001b\[2Jrepo/);
  });
}

test("uses master-detail only at the 88-column breakpoint", () => {
  assert.match(stripAnsi(render(state(88, 20)).rows.join("\n")), /DETAILS/);
  assert.doesNotMatch(stripAnsi(render(state(87, 20)).rows.join("\n")), /DETAILS/);
  assert.match(stripAnsi(render(state(87, 20)).rows.join("\n")), /workspace/);
});

test("centers the selected item in a scrolling window", () => {
  const plain = stripAnsi(render(state(87, 12)).rows.join("\n"));
  assert.match(plain, /界é/);
  assert.match(plain, /more/);
  assert.doesNotMatch(plain, /topic-14/);
});

test("does not place the create cursor on clipped content", () => {
  const clipped = render({ ...state(20, 7), mode: "create", form: { directory: "topic", branch: "", base: "" }, caret: 5 });
  assert.equal(clipped.cursor, undefined);
  const narrow = render({ ...state(2, 15), mode: "create", form: { directory: "topic", branch: "", base: "" }, caret: 5 });
  assert.equal(narrow.cursor, undefined);
});

test("renders loading, create and remove modes with cursor policy", () => {
  const loading = render({ ...initialState({ width: 80, height: 15 }), operation: "discovering" });
  assert.match(stripAnsi(loading.rows.join("\n")), /Loading worktrees/);
  assert.equal(loading.cursor, undefined);
  const create = render({ ...state(80, 15), mode: "create", form: { directory: "topic", branch: "", base: "" }, caret: 5 });
  assert.match(stripAnsi(create.rows.join("\n")), /CREATE WORKTREE/);
  assert.ok(create.cursor);
  const remove = render({ ...state(80, 15), mode: "remove", removeTarget: "/repo/topic-7", deleteBranch: true });
  assert.match(stripAnsi(remove.rows.join("\n")), /delete merged local branch/);
  assert.equal(remove.cursor, undefined);
});
