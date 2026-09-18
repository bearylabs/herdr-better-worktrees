import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitWorktreeService } from "./core/service.js";
import { NodeCommandRunner } from "./core/runner.js";
import { HerdrClient } from "./herdr-client.js";
import { ManagerApp } from "./ui/app.js";
import { TerminalSession, type ProcessHooks } from "./ui/terminal.js";

export async function main(): Promise<number> {
  const runner = new NodeCommandRunner();
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
  const terminal = new TerminalSession(process.stdin, process.stdout, process as unknown as ProcessHooks);
  const app = new ManagerApp(
    terminal,
    new GitWorktreeService(
      runner,
      join(pluginRoot, "scripts", "new-worktree.sh"),
      join(pluginRoot, "scripts", "clone-canonical.sh"),
      join(pluginRoot, "scripts", "init-canonical.sh"),
    ),
    new HerdrClient(runner),
    {
      cwd: process.cwd(),
      ...(process.env.BETTER_WORKTREES_SOURCE_PANE_ID ? { sourcePaneId: process.env.BETTER_WORKTREES_SOURCE_PANE_ID } : {}),
      ...(process.env.BETTER_WORKTREES_SOURCE_WORKSPACE_ID ? { sourceWorkspaceId: process.env.BETTER_WORKTREES_SOURCE_WORKSPACE_ID } : {}),
    },
  );
  try {
    app.start();
    await app.waitUntilStopped();
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    app.stop("startup failure");
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// Herdr owns the popup pane for exactly as long as its entrypoint process is
// alive. Terminate after ManagerApp has restored terminal input/cursor state
// and aborted its work so Herdr can close the popup.
void main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
