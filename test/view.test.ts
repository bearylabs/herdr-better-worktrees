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

test("leaves one cell of breathing room beside the popup content", () => {
  const frame = render(state(100, 24));
  for (const row of frame.rows) {
    const plain = stripAnsi(row);
    assert.equal(plain.startsWith(" "), true);
    assert.equal(plain.endsWith(" "), true);
  }
});

test("uses square corners throughout the popup", () => {
  const popup = stripAnsi(render(state(100, 24)).rows.join("\n"));
  assert.doesNotMatch(popup, /[╭╮╰╯]/);
  assert.match(popup, /┌─+┐/);
  assert.match(popup, /└─+┘/);
});

test("separates keybinding hints with bullets", () => {
  const list = stripAnsi(render(state(120, 15)).rows.at(-1) ?? "");
  const create = stripAnsi(render({ ...state(120, 15), mode: "create" }).rows.at(-1) ?? "");
  const remove = stripAnsi(render({ ...state(120, 15), mode: "remove", removeTarget: "/repo/topic-7" }).rows.at(-1) ?? "");
  assert.match(list, /move  •  enter/);
  assert.match(create, /fields  •  enter/);
  assert.match(remove, /confirm  •  b branch/);
});

test("uses master-detail when the inset content reaches 88 columns", () => {
  assert.match(stripAnsi(render(state(90, 20)).rows.join("\n")), /DETAILS/);
  assert.doesNotMatch(stripAnsi(render(state(89, 20)).rows.join("\n")), /DETAILS/);
  assert.match(stripAnsi(render(state(89, 20)).rows.join("\n")), /workspace/);
});

test("pads content inside worktree and details boxes", () => {
  const compactRows = render(state(87, 18)).rows.map(stripAnsi);
  const worktreeRow = compactRows.find((row) => row.includes("branch-7"));
  assert.match(worktreeRow ?? "", /^ │ .* │ $/);

  const detailedRows = render(state(100, 24)).rows.map(stripAnsi);
  const detailRow = detailedRows.find((row) => row.includes("Branch") && row.includes("branch-7"));
  assert.match(detailRow ?? "", /│ Branch\s+branch-7.* │ $/);
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
