import assert from "node:assert/strict";
import test from "node:test";
import { failure, success, type WorktreeInventory } from "../src/core/domain.js";
import { ManagerApp } from "../src/ui/app.js";
import type { Frame } from "../src/ui/ansi.js";
import type { NormalizedKey, Terminal } from "../src/ui/terminal.js";

const inventory: WorktreeInventory = {
  root: { path: "/repo", commonDirectory: "/repo/.bare", name: "repo" },
  worktrees: [{ path: "/repo/main", localDirectory: "main", head: "abc", branch: "main", isDetached: false, isCurrent: true, status: { kind: "loading" } }],
};

class FakeTerminal implements Terminal {
  size = { width: 90, height: 20 };
  frames: Array<{ frame: Frame; immediate: boolean }> = [];
  stopped = 0;
  key?: (key: NormalizedKey) => void;
  resize?: (width: number, height: number) => void;
  start(key: (key: NormalizedKey) => void, resize: (width: number, height: number) => void): void { this.key = key; this.resize = resize; }
  paint(frame: Frame, immediate = false): void { this.frames.push({ frame, immediate }); }
  stop(): void { this.stopped += 1; }
}

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

test("first paint is synchronous and precedes context and Git work", async () => {
  const terminal = new FakeTerminal();
  const calls: string[] = [];
  let scheduled: (() => void) | undefined;
  const service = {
    async list() { calls.push("list"); return success(inventory); },
    async loadStatuses(_inventory: WorktreeInventory, callback: any) { calls.push("statuses"); callback("/repo/main", { kind: "clean" }); },
    async fetch() { return success(inventory); }, async create() { return success(inventory); },
    async remove() { throw new Error("unused"); },
  };
  const herdr = {
    async paneContext() { calls.push("context"); return { cwd: "/repo/main" }; },
    async workspaceName() { return undefined; }, async openWorktree() {},
  };
  const app = new ManagerApp(terminal, service as any, herdr, { cwd: "/fallback", schedule: (callback) => { scheduled = callback; } });
  app.start();
  assert.equal(terminal.frames.length, 1);
  assert.equal(terminal.frames[0]?.immediate, true);
  assert.deepEqual(calls, []);
  scheduled!(); await tick(); await tick();
  assert.deepEqual(calls, ["context", "list", "statuses"]);
  assert.equal(app.snapshot().inventory?.worktrees[0]?.status.kind, "clean");
});

test("workspace-name lookup stays lazy and cannot delay inventory", async () => {
  const terminal = new FakeTerminal();
  let nameCalls = 0;
  let lists = 0;
  const service = {
    async list() { lists++; return success(inventory); }, async loadStatuses() {}, async fetch() { return success(inventory); },
    async create() { return success(inventory); }, async remove() { throw new Error("unused"); },
  };
  const herdr = {
    async paneContext() { return { cwd: "/repo" }; },
    async workspaceName() { nameCalls++; return new Promise<string>(() => {}); },
    async openWorktree() {},
  };
  const app = new ManagerApp(terminal, service as any, herdr, { cwd: "/repo", sourceWorkspaceId: "workspace-1" });
  app.start(); await tick(); await tick();
  assert.equal(lists, 1);
  assert.equal(nameCalls, 0);
  assert.ok(app.snapshot().inventory);
  app.stop();
});

test("successful clone switches the manager to the new canonical root", async () => {
  const terminal = new FakeTerminal();
  const cloned = {
    root: { path: "/projects/new-repo", commonDirectory: "/projects/new-repo/.bare", name: "new-repo" },
    worktrees: [{ path: "/projects/new-repo/main", localDirectory: "main", head: "def", branch: "main", isDetached: false, isCurrent: false, status: { kind: "loading" as const } }],
  };
  const service = {
    async list() { return success(inventory); }, async loadStatuses() {}, async fetch() { return success(inventory); },
    async create() { return success(inventory); }, async clone() { return success(cloned); }, async remove() { throw new Error("unused"); },
  };
  const herdr = { async paneContext() { return { cwd: "/projects" }; }, async workspaceName() { return undefined; }, async openWorktree() {} };
  const app = new ManagerApp(terminal, service as any, herdr, { cwd: "/projects" });
  app.start(); await tick(); await tick();
  terminal.key!({ key: "character", text: "c" });
  for (const character of "remote") terminal.key!({ key: "character", text: character });
  terminal.key!({ key: "tab" });
  for (const character of "new-repo") terminal.key!({ key: "character", text: character });
  terminal.key!({ key: "enter" }); await tick();
  assert.equal(app.snapshot().cwd, "/projects/new-repo");
  assert.equal(app.snapshot().inventory?.root.path, "/projects/new-repo");
  assert.equal(app.snapshot().message, "Repository cloned");
  app.stop();
});

test("failed open does not exit", async () => {
  const terminal = new FakeTerminal();
  const service = {
    async list() { return success(inventory); }, async loadStatuses() {}, async fetch() { return success(inventory); },
    async create() { return success(inventory); }, async remove() { throw new Error("unused"); },
  };
  const herdr = {
    async paneContext() { return { cwd: "/repo" }; }, async workspaceName() { return "dev"; },
    async openWorktree() { throw new Error("open failed"); },
  };
  const app = new ManagerApp(terminal, service as any, herdr, { cwd: "/repo" });
  app.start(); await tick(); await tick();
  terminal.key!({ key: "enter" }); await tick();
  assert.equal(terminal.stopped, 0);
  assert.equal(app.snapshot().operation, "error");
  assert.match(app.snapshot().message, /open failed/);
  app.stop();
});

test("quit aborts current work", async () => {
  const terminal = new FakeTerminal();
  let rejectList: ((error: Error) => void) | undefined;
  const service = {
    list: () => new Promise<any>((_resolve, reject) => { rejectList = reject; }),
    async loadStatuses() {}, async fetch() { return failure(new Error("fetch failed")); },
    async create() { return success(inventory); }, async remove() { return success({ removedPath: "x", branchCleanup: { kind: "kept" as const } }); },
  };
  const herdr = { async paneContext() { return { cwd: "/repo" }; }, async workspaceName() { return "dev"; }, async openWorktree() { throw new Error("open failed"); } };
  const app = new ManagerApp(terminal, service as any, herdr, { cwd: "/repo" });
  app.start(); await tick();
  terminal.key!({ key: "character", text: "q" });
  await app.waitUntilStopped();
  assert.equal(terminal.stopped, 1);
  rejectList?.(new Error("aborted"));
});

test("successful open stops the app and completes its process lifecycle", async () => {
  const terminal = new FakeTerminal();
  let opens = 0;
  const service = {
    async list() { return success(inventory); }, async loadStatuses() {}, async fetch() { return success(inventory); },
    async create() { return success(inventory); }, async remove() { throw new Error("unused"); },
  };
  const herdr = {
    async paneContext() { return { cwd: "/repo", workspaceId: "source" }; },
    async workspaceName() { return "development"; },
    async openWorktree() { opens++; },
  };
  const app = new ManagerApp(terminal, service as any, herdr, { cwd: "/repo" });
  app.start(); await tick(); await tick();
  terminal.key!({ key: "enter" });
  await app.waitUntilStopped();
  assert.equal(opens, 1);
  assert.equal(terminal.stopped, 1);
});

test("resize repaints without restarting services", async () => {
  const terminal = new FakeTerminal();
  let lists = 0;
  const service = { async list() { lists++; return success(inventory); }, async loadStatuses() {}, async fetch() { return success(inventory); }, async create() { return success(inventory); }, async remove() { throw new Error(); } };
  const herdr = { async paneContext() { return { cwd: "/repo" }; }, async workspaceName() { return undefined; }, async openWorktree() {} };
  const app = new ManagerApp(terminal, service as any, herdr, { cwd: "/repo" });
  app.start(); await tick(); await tick();
  terminal.resize!(70, 12);
  assert.equal(app.snapshot().viewport.width, 70);
  assert.equal(lists, 1);
});
