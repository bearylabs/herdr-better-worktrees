import assert from "node:assert/strict";
import test from "node:test";
import { HerdrClient } from "../src/herdr-client.js";
import type { CommandRunner, RunOptions } from "../src/core/runner.js";

class CapturingRunner implements CommandRunner {
  calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

  constructor(private readonly responses: string[] = []) {}

  async run(command: string, args: ReadonlyArray<string>, _options?: RunOptions) {
    this.calls.push({ command, args });
    return { stdout: this.responses.shift() ?? "{}", stderr: "", code: 0, killed: false };
  }
}

test("opens and names a standalone workspace after its source workspace", async () => {
  const runner = new CapturingRunner();
  await new HerdrClient(runner, "/bin/herdr").openWorktree(
    "/repo", "/repo/topic", "workspace", undefined, "development",
  );
  assert.deepEqual(runner.calls, [
    { command: "/bin/herdr", args: ["workspace", "list"] },
    { command: "/bin/herdr", args: ["pane", "list"] },
    { command: "/bin/herdr", args: ["workspace", "create", "--cwd", "/repo/topic", "--label", "development", "--focus"] },
  ]);
});

test("focuses an existing standalone workspace instead of creating a duplicate", async () => {
  const runner = new CapturingRunner([
    JSON.stringify({ result: { workspaces: [{ workspace_id: "other" }, { workspace_id: "topic" }] } }),
    JSON.stringify({ result: { panes: [
      { workspace_id: "other", cwd: "/repo/other" },
      { workspace_id: "topic", cwd: "/repo/topic", foreground_cwd: "/repo/topic/src" },
    ] } }),
  ]);
  await new HerdrClient(runner, "/bin/herdr").openWorktree(
    "/repo", "/repo/topic", "workspace", undefined, "development",
  );
  assert.deepEqual(runner.calls, [
    { command: "/bin/herdr", args: ["workspace", "list"] },
    { command: "/bin/herdr", args: ["pane", "list"] },
    { command: "/bin/herdr", args: ["workspace", "rename", "topic", "development"] },
    { command: "/bin/herdr", args: ["workspace", "focus", "topic"] },
  ]);
});

test("focuses a registered worktree workspace without scanning panes", async () => {
  const runner = new CapturingRunner([
    JSON.stringify({ result: { workspaces: [{
      workspace_id: "topic",
      worktree: { checkout_path: "/repo/topic" },
    }] } }),
  ]);
  await new HerdrClient(runner, "/bin/herdr").openWorktree(
    "/repo", "/repo/topic", "workspace", undefined, "development",
  );
  assert.deepEqual(runner.calls, [
    { command: "/bin/herdr", args: ["workspace", "list"] },
    { command: "/bin/herdr", args: ["workspace", "rename", "topic", "development"] },
    { command: "/bin/herdr", args: ["workspace", "focus", "topic"] },
  ]);
});

test("passes source context into the manager without looking it up before opening", async () => {
  const runner = new CapturingRunner(["{}"]);
  const client = new HerdrClient(runner, "/bin/herdr");
  await client.openManagerPopup("/repo/src", { paneId: "pane", workspaceId: "source" });
  assert.deepEqual(runner.calls, [{
    command: "/bin/herdr",
    args: [
      "plugin", "pane", "open", "--plugin", "herdr-better-worktrees", "--entrypoint", "manager",
      "--placement", "popup", "--width", "90%", "--height", "82%", "--cwd", "/repo/src",
      "--env", "BETTER_WORKTREES_SOURCE_PANE_ID=pane",
      "--env", "BETTER_WORKTREES_SOURCE_WORKSPACE_ID=source",
      "--focus",
    ],
  }]);
});

test("reads source pane context inside the manager", async () => {
  const runner = new CapturingRunner([
    JSON.stringify({ result: { pane: {
      cwd: "/repo", foreground_cwd: "/repo/src", workspace_id: "source",
    } } }),
  ]);
  const context = await new HerdrClient(runner, "/bin/herdr").paneContext("pane");
  assert.deepEqual(context, { cwd: "/repo/src", workspaceId: "source" });
  assert.deepEqual(runner.calls, [{ command: "/bin/herdr", args: ["pane", "get", "pane"] }]);
});

test("reads the source workspace name without its numeric display prefix", async () => {
  const runner = new CapturingRunner([
    JSON.stringify({ result: { workspace: { label: "[7] development", number: 7 } } }),
  ]);
  const name = await new HerdrClient(runner, "/bin/herdr").workspaceName("source");
  assert.equal(name, "development");
  assert.deepEqual(runner.calls, [{
    command: "/bin/herdr", args: ["workspace", "get", "source"],
  }]);
});

test("opens and names a nested Herdr worktree after the branch", async () => {
  const runner = new CapturingRunner();
  await new HerdrClient(runner, "/bin/herdr").openWorktree("/repo", "/repo/topic", "nested", "feature/topic");
  assert.deepEqual(runner.calls, [{
    command: "/bin/herdr",
    args: [
      "worktree", "open", "--cwd", "/repo", "--path", "/repo/topic",
      "--label", "feature/topic", "--focus",
    ],
  }]);
});

test("uses the checkout directory as nested label for a detached worktree", async () => {
  const runner = new CapturingRunner();
  await new HerdrClient(runner, "/bin/herdr").openWorktree("/repo", "/repo/detached", "nested");
  assert.deepEqual(runner.calls[0]?.args, [
    "worktree", "open", "--cwd", "/repo", "--path", "/repo/detached",
    "--label", "detached", "--focus",
  ]);
});
