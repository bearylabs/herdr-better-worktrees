import assert from "node:assert/strict";
import test from "node:test";
import type { WorktreeInventory } from "../src/core/domain.js";
import { initialState, selectedWorktree, update, type ManagerState } from "../src/ui/model.js";

const inventory: WorktreeInventory = {
  root: { path: "/repo", commonDirectory: "/repo/.bare", name: "repo" },
  worktrees: [
    { path: "/repo/main", localDirectory: "main", head: "abcdef", branch: "main", isDetached: false, isCurrent: true, status: { kind: "loading" } },
    { path: "/repo/topic", localDirectory: "topic", head: "123456", branch: "topic", isDetached: false, isCurrent: false, status: { kind: "loading" } },
  ],
};

function ready(): ManagerState {
  let state = initialState({ width: 100, height: 24 }, "/fallback");
  let next = update(state, { type: "context", cwd: "/repo/main", workspaceId: "w" });
  state = next.state;
  assert.deepEqual(next.effects, [{ type: "load", cwd: "/repo/main", token: 1, notice: "Ready" }]);
  next = update(state, { type: "inventory", token: 1, inventory, notice: "Ready" });
  assert.equal(next.effects[0]?.type, "load-statuses");
  return next.state;
}

test("navigates with arrows and Vim keys and clamps bounds", () => {
  let state = ready();
  state = update(state, { type: "key", key: "down" }).state;
  assert.equal(selectedWorktree(state)?.path, "/repo/topic");
  state = update(state, { type: "key", key: "character", text: "j" }).state;
  assert.equal(state.selected, 1);
  state = update(state, { type: "key", key: "character", text: "k" }).state;
  assert.equal(state.selected, 0);
});

test("preserves selected full path across reordered inventory", () => {
  let state = update(ready(), { type: "key", key: "down" }).state;
  state = { ...state, operation: "refreshing", operationToken: 2 };
  const reordered = { ...inventory, worktrees: [...inventory.worktrees].reverse() };
  state = update(state, { type: "inventory", token: 2, inventory: reordered, notice: "Refreshed" }).state;
  assert.equal(selectedWorktree(state)?.path, "/repo/topic");
});

test("toggles open mode and reports the new mode", () => {
  const state = update(ready(), { type: "key", key: "character", text: "m" }).state;
  assert.equal(state.openMode, "nested");
  assert.match(state.message, /nested worktree/);
});

test("captures remove identity and toggles cleanup", () => {
  let state = update(ready(), { type: "key", key: "down" }).state;
  state = update(state, { type: "key", key: "character", text: "d" }).state;
  assert.equal(state.removeTarget, "/repo/topic");
  state = update(state, { type: "key", key: "character", text: "b" }).state;
  const confirmed = update(state, { type: "key", key: "enter" });
  assert.equal(confirmed.effects[0]?.type, "remove");
  assert.equal(confirmed.effects[0]?.type === "remove" && confirmed.effects[0].path, "/repo/topic");
  assert.equal(confirmed.effects[0]?.type === "remove" && confirmed.effects[0].deleteBranch, true);
});

test("edits create fields at a grapheme-safe caret", () => {
  let state = update(ready(), { type: "key", key: "character", text: "a" }).state;
  state = update(state, { type: "key", key: "character", text: "A" }).state;
  state = update(state, { type: "key", key: "character", text: "👩‍💻" }).state;
  state = update(state, { type: "key", key: "left" }).state;
  state = update(state, { type: "key", key: "character", text: "e\u0301" }).state;
  assert.equal(state.form.directory, "Ae\u0301👩‍💻");
  state = update(state, { type: "key", key: "backspace" }).state;
  assert.equal(state.form.directory, "A👩‍💻");
  state = update(state, { type: "key", key: "tab" }).state;
  assert.equal(state.field, 1);
});

test("ignores stale status and operation completions", () => {
  const state = ready();
  const staleStatus = update(state, { type: "status", token: 0, path: "/repo/main", status: { kind: "clean" } }).state;
  assert.equal(staleStatus.inventory?.worktrees[0]?.status.kind, "loading");
  const staleFailure = update(state, { type: "failure", token: 999, message: "bad" }).state;
  assert.equal(staleFailure.message, "Ready");
});

test("busy mode accepts quit but ignores operations", () => {
  const state = { ...ready(), operation: "fetching" as const };
  assert.equal(update(state, { type: "key", key: "character", text: "a" }).effects.length, 0);
  assert.deepEqual(update(state, { type: "key", key: "character", text: "q" }).effects, [{ type: "exit" }]);
});

test("empty inventory makes open and remove no-ops", () => {
  const base = ready();
  const state = { ...base, inventory: { ...inventory, worktrees: [] }, selected: 0 };
  assert.equal(update(state, { type: "key", key: "enter" }).effects.length, 0);
  assert.equal(update(state, { type: "key", key: "character", text: "d" }).state.mode, "list");
});
