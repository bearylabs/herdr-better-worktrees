import type { WorktreeStatus } from "../core/domain.js";
import type { GitWorktreeService } from "../core/service.js";
import type { HerdrClient } from "../herdr-client.js";
import { initialState, update, type Effect, type Event, type ManagerState } from "./model.js";
import type { Terminal } from "./terminal.js";
import { render } from "./view.js";

export type AppOptions = {
  readonly cwd: string;
  readonly sourcePaneId?: string;
  readonly sourceWorkspaceId?: string;
  readonly schedule?: (callback: () => void) => void;
};

export class ManagerApp {
  private state: ManagerState;
  private stopped = false;
  private operationController: AbortController | undefined;
  private statusController: AbortController | undefined;
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped!: () => void;

  constructor(
    private readonly terminal: Terminal,
    private readonly service: Pick<GitWorktreeService, "list" | "loadStatuses" | "fetch" | "create" | "clone" | "initialize" | "remove">,
    private readonly herdr: Pick<HerdrClient, "paneContext" | "workspaceName" | "openWorktree">,
    private readonly options: AppOptions,
  ) {
    this.state = initialState(terminal.size, options.cwd);
    this.stoppedPromise = new Promise((resolve) => { this.resolveStopped = resolve; });
  }

  start(): void {
    try {
      this.terminal.start(
        ({ key, text }) => this.dispatch({ type: "key", key, ...(text === undefined ? {} : { text }) }),
        (width, height) => this.dispatch({ type: "resize", width, height }),
        (reason) => this.stop(reason),
      );
      // Deliberately synchronous: no pane, Git, or Herdr promise precedes chrome.
      this.terminal.paint(render(this.state), true);
      (this.options.schedule ?? queueMicrotask)(() => this.run({ type: "resolve-context" }));
    } catch (error) {
      this.stop("initialization failure");
      throw error;
    }
  }

  dispatch(event: Event): void {
    if (this.stopped) return;
    const next = update(this.state, event);
    this.state = next.state;
    this.terminal.paint(render(this.state));
    for (const effect of next.effects) this.run(effect);
  }

  stop(_reason = "exit"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.operationController?.abort(); this.operationController = undefined;
    this.statusController?.abort(); this.statusController = undefined;
    try { this.terminal.stop(); }
    finally { this.resolveStopped(); }
  }

  waitUntilStopped(): Promise<void> { return this.stoppedPromise; }

  snapshot(): ManagerState { return this.state; }

  private run(effect: Effect): void {
    if (this.stopped) return;
    if (effect.type === "exit") { this.stop("user exit"); return; }
    if (effect.type === "load-statuses") {
      this.statusController?.abort();
      const controller = new AbortController(); this.statusController = controller;
      const statuses: Array<{ path: string; status: WorktreeStatus }> = [];
      void this.service.loadStatuses(effect.inventory, (path, status) => {
        statuses.push({ path, status });
      }, controller.signal).then(() => {
        // Apply the completed status scan as one frame. Incremental updates made
        // the popup look as if its contents were still being assembled.
        if (!controller.signal.aborted) this.dispatch({ type: "statuses", token: effect.token, values: statuses });
      }).catch(() => {
        // Individual status failures are represented as `unavailable` by the
        // service. A run-level failure must not replace a foreground message.
      }).finally(() => { if (this.statusController === controller) this.statusController = undefined; });
      return;
    }
    this.operationController?.abort();
    const controller = new AbortController(); this.operationController = controller;
    const complete = async () => {
      try {
        await this.execute(effect, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted && "token" in effect) this.dispatch({ type: "failure", token: effect.token, message: errorMessage(error) });
      } finally {
        if (this.operationController === controller) this.operationController = undefined;
      }
    };
    void complete();
  }

  private async execute(effect: Exclude<Effect, { type: "exit" | "load-statuses" }>, signal: AbortSignal): Promise<void> {
    if (effect.type === "resolve-context") {
      try {
        const context = await this.herdr.paneContext(this.options.sourcePaneId, signal);
        const workspaceId = context.workspaceId ?? this.options.sourceWorkspaceId;
        // Workspace naming is only needed for standalone opens. Keeping that
        // lookup lazy prevents Herdr latency/failure from delaying Git inventory.
        if (!signal.aborted) this.dispatch({ type: "context", cwd: context.cwd, ...(workspaceId ? { workspaceId } : {}) });
      } catch {
        if (!signal.aborted) this.dispatch({ type: "context-failed", cwd: this.options.cwd });
      }
      return;
    }
    if (effect.type === "load") {
      const result = await this.service.list(effect.cwd, signal);
      if (signal.aborted) return;
      if (result.ok) this.dispatch({ type: "inventory", token: effect.token, inventory: result.value, notice: effect.notice });
      else this.dispatch({ type: "failure", token: effect.token, message: result.error.message });
      return;
    }
    if (effect.type === "fetch") {
      const result = await this.service.fetch(effect.cwd, signal);
      if (signal.aborted) return;
      if (result.ok) this.dispatch({ type: "inventory", token: effect.token, inventory: result.value, notice: "Fetched origin" });
      else this.dispatch({ type: "failure", token: effect.token, message: result.error.message });
      return;
    }
    if (effect.type === "create") {
      const result = await this.service.create(effect.cwd, effect.input, signal);
      if (signal.aborted) return;
      if (result.ok) {
        const preferredPath = result.value.worktrees.find((item) => item.localDirectory === effect.directory)?.path;
        this.dispatch({ type: "inventory", token: effect.token, inventory: result.value, notice: "Worktree created", ...(preferredPath ? { preferredPath } : {}) });
      } else this.dispatch({ type: "failure", token: effect.token, message: result.error.message });
      return;
    }
    if (effect.type === "clone") {
      const result = await this.service.clone(effect.cwd, effect.input, signal);
      if (signal.aborted) return;
      if (result.ok) {
        this.dispatch({
          type: "inventory", token: effect.token, inventory: result.value,
          notice: "Repository cloned", cwd: result.value.root.path,
        });
      } else this.dispatch({ type: "failure", token: effect.token, message: result.error.message });
      return;
    }
    if (effect.type === "initialize") {
      const result = await this.service.initialize(effect.cwd, effect.input, signal);
      if (signal.aborted) return;
      if (result.ok) {
        this.dispatch({
          type: "inventory", token: effect.token, inventory: result.value,
          notice: "Repository initialized", cwd: result.value.root.path,
        });
      } else this.dispatch({ type: "failure", token: effect.token, message: result.error.message });
      return;
    }
    if (effect.type === "remove") {
      const result = await this.service.remove(effect.cwd, { path: effect.path, branchCleanup: effect.deleteBranch ? "delete-merged" : "keep" }, signal);
      if (signal.aborted) return;
      if (!result.ok) { this.dispatch({ type: "failure", token: effect.token, message: result.error.message }); return; }
      const cleanup = result.value.branchCleanup;
      const notice = cleanup.kind === "deleted" ? `Removed worktree and branch ${cleanup.branch}`
        : cleanup.kind === "retained" ? `Removed worktree; branch retained: ${cleanup.reason}` : "Worktree removed";
      this.dispatch({ type: "removed", token: effect.token, notice });
      return;
    }
    let workspaceName = this.state.workspaceNameOverride ?? this.state.sourceWorkspaceName;
    if (effect.mode === "workspace" && !workspaceName) {
      workspaceName = await this.herdr.workspaceName(this.state.sourceWorkspaceId, signal);
      if (workspaceName && !signal.aborted) this.dispatch({ type: "workspace-name", token: effect.token, name: workspaceName });
    }
    await this.herdr.openWorktree(effect.root, effect.path, effect.mode, effect.branch, workspaceName, signal);
    if (!signal.aborted) this.dispatch({ type: "opened", token: effect.token });
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
