import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { countStatusChanges, parseGitWorktreePorcelain, type ParsedGitWorktree } from "./git-output.js";
import type { CommandResult, CommandRunner } from "./runner.js";
import {
  CanonicalRootNotFound,
  failure,
  GitCommandFailed,
  InvalidInput,
  success,
  UnsafeRemoval,
  WorktreeNotFound,
  type BranchCleanupOutcome,
  type CloneRepositoryInput,
  type CreateWorktreeInput,
  type RemoveWorktreeInput,
  type Result,
  type WorktreeInventory,
  type WorktreeRecord,
  type WorktreeRoot,
  type WorktreeStatus,
} from "./domain.js";

export class GitWorktreeService {
  private cachedRoot: { readonly context: string; readonly root: WorktreeRoot } | undefined;

  constructor(
    private readonly runner: CommandRunner,
    private readonly createScriptPath: string,
    private readonly cloneScriptPath = createScriptPath.replace(/new-worktree\.sh$/, "clone-canonical.sh"),
  ) {}

  async list(cwd: string, signal?: AbortSignal): Promise<Result<WorktreeInventory>> {
    const rootResult = await this.discoverRoot(cwd, signal);
    return rootResult.ok ? this.listFromRoot(rootResult.value, cwd, signal) : rootResult;
  }

  async loadStatuses(
    inventory: WorktreeInventory,
    onStatus: (path: string, status: WorktreeStatus) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let nextIndex = 0;
    const worker = async () => {
      while (!signal?.aborted) {
        const item = inventory.worktrees[nextIndex++];
        if (!item) return;
        const status = await this.status(item.path, signal);
        if (!signal?.aborted) onStatus(item.path, status);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, inventory.worktrees.length) }, worker));
  }

  async fetch(cwd: string, signal?: AbortSignal): Promise<Result<WorktreeInventory>> {
    const root = await this.discoverRoot(cwd, signal);
    if (!root.ok) return root;
    const fetched = await this.git("fetch", ["-C", root.value.path, "fetch", "--prune", "origin"], cwd, signal);
    return fetched.ok ? this.listFromRoot(root.value, cwd, signal) : fetched;
  }

  async create(cwd: string, input: CreateWorktreeInput, signal?: AbortSignal): Promise<Result<WorktreeInventory>> {
    const invalid = validateCreate(input);
    if (invalid) return failure(invalid);
    const branch = input.branch?.trim() || input.localDirectory.trim();
    const args = [input.localDirectory, branch, ...(input.base ? [input.base] : [])];
    const created = await this.command("create", this.createScriptPath, args, cwd, signal);
    return created.ok ? this.list(cwd, signal) : created;
  }

  async clone(cwd: string, input: CloneRepositoryInput, signal?: AbortSignal): Promise<Result<WorktreeInventory>> {
    const url = input.url.trim();
    const destination = input.destination?.trim() || inferRepositoryName(url);
    const invalid = !url
      ? new InvalidInput("URL", url, "must not be empty")
      : url.startsWith("-")
        ? new InvalidInput("URL", url, "must not start with '-'")
        : !destination
          ? new InvalidInput("destination", "", "could not infer a repository name from the URL")
          : undefined;
    if (invalid) return failure(invalid);
    const destinationPath = resolve(cwd, expandHome(destination));
    const cloned = await this.command("clone", this.cloneScriptPath, [url, destinationPath], cwd, signal);
    if (!cloned.ok) return cloned;
    this.cachedRoot = undefined;
    return this.list(destinationPath, signal);
  }

  async remove(
    cwd: string,
    input: RemoveWorktreeInput,
    signal?: AbortSignal,
  ): Promise<Result<{ readonly removedPath: string; readonly branchCleanup: BranchCleanupOutcome }>> {
    const inventory = await this.list(cwd, signal);
    if (!inventory.ok) return inventory;
    const requestedPath = await existingPath(input.path);
    const candidates = await Promise.all(inventory.value.worktrees.map(async (item) => ({
      item,
      path: await existingPath(item.path),
    })));
    const target = candidates.find((candidate) => candidate.path === requestedPath)?.item;
    if (!target) return failure(new WorktreeNotFound(input.path));
    if (target.isCurrent) return failure(new UnsafeRemoval(`Cannot remove the current worktree: ${target.path}`));
    if (target.lockedReason !== undefined) return failure(new UnsafeRemoval(`Cannot remove locked worktree: ${target.lockedReason || target.path}`));

    // The displayed status may still be loading or may have become stale while
    // the confirmation view was open. Removal always uses a fresh check.
    const status = await this.status(target.path, signal);
    if (status.kind === "dirty") return failure(new UnsafeRemoval(`${target.path} has ${status.changedFileCount} uncommitted change(s)`));
    if (status.kind === "unavailable") return failure(new UnsafeRemoval(status.reason));

    const removed = await this.git("remove", ["-C", inventory.value.root.path, "worktree", "remove", "--", target.path], cwd, signal);
    if (!removed.ok) return removed;
    if (input.branchCleanup === "keep" || !target.branch) {
      return success({ removedPath: target.path, branchCleanup: { kind: "kept" } });
    }
    const deleted = await this.git("delete-branch", ["-C", inventory.value.root.path, "branch", "-d", "--", target.branch], cwd, signal);
    if (!deleted.ok) {
      return success({ removedPath: target.path, branchCleanup: { kind: "retained", branch: target.branch, reason: deleted.error.message } });
    }
    return success({ removedPath: target.path, branchCleanup: { kind: "deleted", branch: target.branch } });
  }

  async discoverRoot(cwd: string, signal?: AbortSignal): Promise<Result<WorktreeRoot>> {
    const context = await existingPath(cwd);
    if (this.cachedRoot?.context === context) return success(this.cachedRoot.root);
    this.cachedRoot = undefined;

    const common = await this.git("discover", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, signal);
    if (!common.ok) return failure(new CanonicalRootNotFound(cwd, common.error));
    const commonDirectory = resolve(common.value.stdout.trim());
    if (basename(commonDirectory) !== ".bare") return failure(new CanonicalRootNotFound(cwd));
    const rootPath = dirname(commonDirectory);
    const bare = await this.git("discover", ["-C", rootPath, "rev-parse", "--is-bare-repository"], cwd, signal);
    if (!bare.ok || bare.value.stdout.trim() !== "true") return failure(new CanonicalRootNotFound(cwd, bare.ok ? undefined : bare.error));
    const root = { path: rootPath, commonDirectory, name: basename(rootPath) };
    this.cachedRoot = { context, root };
    return success(root);
  }

  private async listFromRoot(root: WorktreeRoot, cwd: string, signal?: AbortSignal): Promise<Result<WorktreeInventory>> {
    const listed = await this.git("list", ["-C", root.path, "worktree", "list", "--porcelain", "-z"], cwd, signal);
    if (!listed.ok) {
      this.cachedRoot = undefined;
      return listed;
    }
    const parsed = parseGitWorktreePorcelain(listed.value.stdout);
    if (!parsed.ok) return parsed;
    const currentPath = await existingPath(cwd);
    const worktrees = await Promise.all(parsed.value.filter((item) => !item.isBare).map(
      (item) => this.loadRecord(root, currentPath, item),
    ));
    return success({ root, worktrees });
  }

  private async loadRecord(root: WorktreeRoot, currentPath: string, parsed: ParsedGitWorktree): Promise<WorktreeRecord> {
    const linkedPath = await existingPath(parsed.path);
    const relativePath = relative(root.path, parsed.path);
    const localDirectory = relativePath && !relativePath.startsWith(`..${sep}`) && relativePath !== ".." ? relativePath : basename(parsed.path);
    return {
      path: parsed.path,
      localDirectory,
      head: parsed.head,
      isDetached: parsed.isDetached,
      isCurrent: currentPath === linkedPath || currentPath.startsWith(`${linkedPath}${sep}`),
      status: { kind: "loading" },
      ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
      ...(parsed.lockedReason === undefined ? {} : { lockedReason: parsed.lockedReason }),
      ...(parsed.prunableReason === undefined ? {} : { prunableReason: parsed.prunableReason }),
    };
  }

  private async status(path: string, signal?: AbortSignal): Promise<WorktreeStatus> {
    const result = await this.git("status", ["-C", path, "status", "--porcelain=v1", "--untracked-files=normal"], path, signal);
    if (!result.ok) return { kind: "unavailable", reason: result.error.message };
    const count = countStatusChanges(result.value.stdout);
    return count === 0 ? { kind: "clean" } : { kind: "dirty", changedFileCount: count };
  }

  private git(operation: string, args: ReadonlyArray<string>, cwd: string, signal?: AbortSignal): Promise<Result<CommandResult, GitCommandFailed>> {
    return this.command(operation, "git", args, cwd, signal);
  }

  private async command(operation: string, command: string, args: ReadonlyArray<string>, cwd: string, signal?: AbortSignal): Promise<Result<CommandResult, GitCommandFailed>> {
    try {
      const result = await this.runner.run(command, args, { cwd, ...(signal === undefined ? {} : { signal }) });
      return result.code === 0 ? success(result) : failure(new GitCommandFailed(operation, result.stderr || result.stdout, result.code));
    } catch (cause) {
      return failure(new GitCommandFailed(operation, String(cause), -1, cause));
    }
  }
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

function inferRepositoryName(url: string): string {
  const withoutTrailingSlash = url.replace(/\/+$/, "");
  const lastSegment = withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf("/") + 1);
  const name = lastSegment.slice(lastSegment.lastIndexOf(":") + 1).replace(/\.git$/, "");
  return name === "." || name === ".." ? "" : name;
}

function validateCreate(input: CreateWorktreeInput): InvalidInput | undefined {
  const branch = input.branch?.trim() || input.localDirectory.trim();
  return validateDirectory(input.localDirectory)
    ?? (branch.startsWith("-") ? new InvalidInput("branch", branch, "must not start with '-'") : undefined);
}

function validateDirectory(value: string): InvalidInput | undefined {
  return !value || value === "." || value === ".." || value.includes("/") || value.includes("\\")
    ? new InvalidInput("directory", value, "must name one direct child of the canonical root")
    : undefined;
}

async function existingPath(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}
