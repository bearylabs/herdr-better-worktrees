import assert from "node:assert/strict";
import test from "node:test";
import { countStatusChanges, parseGitWorktreePorcelain } from "../src/core/git-output.js";

test("parses bare, linked, detached and locked worktrees", () => {
  const result = parseGitWorktreePorcelain([
    "worktree /repo/.bare", "bare", "",
    "worktree /repo/main", "HEAD abc", "branch refs/heads/main", "",
    "worktree /repo/review", "HEAD def", "detached", "locked in use", "", "",
  ].join("\0"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, [
    { path: "/repo/.bare", head: "", isBare: true, isDetached: false },
    { path: "/repo/main", head: "abc", branch: "main", isBare: false, isDetached: false },
    { path: "/repo/review", head: "def", isBare: false, isDetached: true, lockedReason: "in use" },
  ]);
});

test("rejects linked records without HEAD", () => {
  assert.equal(parseGitWorktreePorcelain("worktree /repo/topic\0branch refs/heads/topic\0\0").ok, false);
});

test("counts status entries", () => {
  assert.equal(countStatusChanges(" M a\nA  b\n?? c\n"), 3);
  assert.equal(countStatusChanges(""), 0);
});
