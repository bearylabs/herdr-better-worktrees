import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorktreeInventory } from "../src/core/domain.js";
import { GitWorktreeService } from "../src/core/service.js";
import { NodeCommandRunner, type CommandResult, type CommandRunner, type RunOptions } from "../src/core/runner.js";

const runner = new NodeCommandRunner();

test("discovers canonical root and enforces safe removal", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "herdr-better-worktrees-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, "source");
  const root = join(base, "project");
  const main = join(root, "main");
  await mkdir(source);
  await git(source, ["init", "-q", "-b", "main"]);
  await git(source, ["config", "user.email", "test@example.invalid"]);
  await git(source, ["config", "user.name", "Test"]);
  await writeFile(join(source, "README.md"), "test\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-qm", "initial"]);
  await mkdir(root);
  await git(root, ["clone", "-q", "--bare", source, ".bare"]);
  await writeFile(join(root, ".git"), "gitdir: ./.bare\n");
  await git(root, ["config", "worktree.useRelativePaths", "true"]);
  await git(root, ["worktree", "add", "-q", "main", "main"]);

  const serviceRunner = new CountingRunner(runner);
  const service = new GitWorktreeService(serviceRunner, join(process.cwd(), "scripts/new-worktree.sh"));
  const inventory = await service.list(main);
  assert.equal(inventory.ok, true);
  if (!inventory.ok) return;
  assert.equal(inventory.value.root.path, await realpath(root));
  assert.equal(inventory.value.worktrees[0]?.localDirectory, "main");
  assert.equal(inventory.value.worktrees[0]?.isCurrent, true);
  assert.equal(inventory.value.worktrees[0]?.status.kind, "loading");
  await service.loadStatuses(inventory.value, (path, status) => {
    assert.equal(path, main);
    assert.equal(status.kind, "clean");
  });

  const currentRemoval = await service.remove(main, { path: main, branchCleanup: "keep" });
  assert.equal(currentRemoval.ok, false);
  if (!currentRemoval.ok) assert.match(currentRemoval.error.message, /current worktree/i);

  const created = await service.create(main, { localDirectory: "topic" });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.worktrees.find((item) => item.localDirectory === "topic")?.branch, "topic");

  const dirtyFile = join(root, "topic", "dirty.txt");
  await writeFile(dirtyFile, "uncommitted\n");
  const dirtyRemoval = await service.remove(main, { path: join(root, "topic"), branchCleanup: "keep" });
  assert.equal(dirtyRemoval.ok, false);
  if (!dirtyRemoval.ok) assert.match(dirtyRemoval.error.message, /uncommitted/i);

  await rm(dirtyFile);
  const removed = await service.remove(main, { path: join(root, "topic"), branchCleanup: "delete-merged" });
  assert.equal(removed.ok, true);
  if (removed.ok) assert.deepEqual(removed.value.branchCleanup, { kind: "deleted", branch: "topic" });

  // Worktrees outside the canonical root may share a basename. Removal must
  // use the selected worktree's full identity rather than the display name.
  const externalOne = join(base, "external-one", "shared");
  const externalTwo = join(base, "external-two", "shared");
  await mkdir(join(base, "external-one"));
  await mkdir(join(base, "external-two"));
  await git(root, ["worktree", "add", "-q", "-b", "external-one", externalOne, "main"]);
  await git(root, ["worktree", "add", "-q", "-b", "external-two", externalTwo, "main"]);

  const externalRemoval = await service.remove(main, { path: externalTwo, branchCleanup: "keep" });
  assert.equal(externalRemoval.ok, true);
  assert.equal(await realpath(externalOne), externalOne);
  await assert.rejects(realpath(externalTwo));
  assert.equal(serviceRunner.discoveryCount, 2, "canonical-root discovery should be cached");
});

test("loads statuses with bounded concurrency", async () => {
  let active = 0;
  let peak = 0;
  const statusRunner: CommandRunner = {
    async run(): Promise<CommandResult> {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
  const service = new GitWorktreeService(statusRunner, "/unused");
  const inventory: WorktreeInventory = {
    root: { path: "/repo", commonDirectory: "/repo/.bare", name: "repo" },
    worktrees: Array.from({ length: 20 }, (_, index) => ({
      path: `/repo/${index}`,
      localDirectory: String(index),
      head: "abc",
      isDetached: false,
      isCurrent: false,
      status: { kind: "loading" },
    })),
  };
  const completed: string[] = [];
  await service.loadStatuses(inventory, (path) => completed.push(path));
  assert.equal(completed.length, 20);
  assert.equal(peak, 6);
});

test("rejects a standard repository", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-standard-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-q"]);
  const result = await new GitWorktreeService(runner, "/unused").list(root);
  assert.equal(result.ok, false);
});

class CountingRunner implements CommandRunner {
  discoveryCount = 0;

  constructor(private readonly delegate: CommandRunner) {}

  run(command: string, args: ReadonlyArray<string>, options?: RunOptions): Promise<CommandResult> {
    if (command === "git" && args.includes("rev-parse")) this.discoveryCount += 1;
    return this.delegate.run(command, args, options);
  }
}

async function git(cwd: string, args: ReadonlyArray<string>): Promise<void> {
  const result = await runner.run("git", args, { cwd });
  assert.equal(result.code, 0, result.stderr);
}
