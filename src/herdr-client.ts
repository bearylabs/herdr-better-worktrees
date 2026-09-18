import { basename, resolve, sep } from "node:path";
import type { CommandRunner } from "./core/runner.js";

export type WorktreeOpenMode = "workspace" | "nested";

export class HerdrClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly binary = process.env.HERDR_BIN_PATH ?? "herdr",
  ) {}

  async openWorktree(
    canonicalRoot: string,
    worktreePath: string,
    mode: WorktreeOpenMode = "workspace",
    branch?: string,
    sourceWorkspaceName?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (mode === "nested") {
      const label = branch ?? basename(resolve(worktreePath));
      await this.run([
        "worktree", "open", "--cwd", canonicalRoot, "--path", worktreePath,
        "--label", label, "--focus",
      ], signal);
      return;
    }

    if (!sourceWorkspaceName) throw new Error("Could not determine the source workspace name");
    const label = sourceWorkspaceName;
    const existingWorkspaceId = await this.findWorkspaceForPath(worktreePath, signal);
    if (existingWorkspaceId) {
      await this.run(["workspace", "rename", existingWorkspaceId, label], signal);
      await this.run(["workspace", "focus", existingWorkspaceId], signal);
      return;
    }
    await this.run(["workspace", "create", "--cwd", worktreePath, "--label", label, "--focus"], signal);
  }

  private async findWorkspaceForPath(worktreePath: string, signal?: AbortSignal): Promise<string | undefined> {
    const workspaceResponse = JSON.parse(await this.run(["workspace", "list"], signal)) as {
      result?: { workspaces?: Array<{ workspace_id?: string; worktree?: { checkout_path?: string } }> };
    };
    const worktreeWorkspace = workspaceResponse.result?.workspaces?.find(
      (workspace) => workspace.workspace_id && workspace.worktree?.checkout_path
        && samePath(workspace.worktree.checkout_path, worktreePath),
    );
    if (worktreeWorkspace?.workspace_id) return worktreeWorkspace.workspace_id;

    const paneResponse = JSON.parse(await this.run(["pane", "list"], signal)) as {
      result?: { panes?: Array<{ workspace_id?: string; cwd?: string; foreground_cwd?: string }> };
    };
    const pane = paneResponse.result?.panes?.find(
      (item) => item.workspace_id
        && [item.cwd, item.foreground_cwd].some((path) => path && isWithin(path, worktreePath)),
    );
    return pane?.workspace_id;
  }

  async workspaceName(workspaceId: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (!workspaceId) return undefined;
    const response = JSON.parse(await this.run(["workspace", "get", workspaceId], signal)) as {
      result?: { workspace?: { label?: string; number?: number } };
    };
    const workspace = response.result?.workspace;
    if (!workspace?.label) return undefined;
    const numberPrefix = workspace.number === undefined ? undefined : `[${workspace.number}] `;
    return numberPrefix && workspace.label.startsWith(numberPrefix)
      ? workspace.label.slice(numberPrefix.length)
      : workspace.label;
  }

  async openManagerPopup(
    cwd: string,
    source: { readonly paneId?: string; readonly workspaceId?: string } = {},
  ): Promise<void> {
    const pluginId = process.env.HERDR_PLUGIN_ID ?? "herdr-better-worktrees";
    const sourceEnvironment = [
      source.paneId ? `BETTER_WORKTREES_SOURCE_PANE_ID=${source.paneId}` : undefined,
      source.workspaceId ? `BETTER_WORKTREES_SOURCE_WORKSPACE_ID=${source.workspaceId}` : undefined,
    ].filter((value): value is string => value !== undefined);
    await this.run([
      "plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "manager",
      "--placement", "popup", "--width", "90%", "--height", "82%", "--cwd", cwd,
      ...sourceEnvironment.flatMap((value) => ["--env", value]),
      "--focus",
    ]);
  }

  async paneContext(paneId: string | undefined, signal?: AbortSignal): Promise<{ cwd: string; workspaceId?: string }> {
    if (!paneId) return { cwd: process.cwd() };
    const response = await this.run(["pane", "get", paneId], signal);
    const parsed = JSON.parse(response) as {
      result?: { pane?: { foreground_cwd?: string; cwd?: string; workspace_id?: string } };
    };
    const pane = parsed.result?.pane;
    return {
      cwd: pane?.foreground_cwd ?? pane?.cwd ?? process.cwd(),
      ...(pane?.workspace_id ? { workspaceId: pane.workspace_id } : {}),
    };
  }

  private async run(args: ReadonlyArray<string>, signal?: AbortSignal): Promise<string> {
    const result = await this.runner.run(this.binary, args, signal ? { signal } : undefined);
    if (result.code !== 0) {
      let message = result.stderr || result.stdout || `herdr exited with ${result.code}`;
      try {
        const parsed = JSON.parse(message) as { error?: { message?: string } };
        message = parsed.error?.message ?? message;
      } catch {}
      throw new Error(message.trim());
    }
    return result.stdout;
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function isWithin(path: string, parent: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedParent = resolve(parent);
  return resolvedPath === resolvedParent || resolvedPath.startsWith(`${resolvedParent}${sep}`);
}
