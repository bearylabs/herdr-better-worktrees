import type { CloneRepositoryInput, CreateWorktreeInput, WorktreeInventory, WorktreeStatus } from "../core/domain.js";
import type { WorktreeOpenMode } from "../herdr-client.js";
import { sanitize } from "./ansi.js";

export type Mode = "list" | "create" | "clone" | "remove";
export type Operation = "discovering" | "idle" | "refreshing" | "fetching" | "creating" | "cloning" | "removing" | "opening" | "error";
export type KeyName = "escape" | "enter" | "tab" | "shift-tab" | "up" | "down" | "left" | "right" | "home" | "end" | "backspace" | "delete" | "ctrl-c" | "character";
export type CreateField = "directory" | "branch" | "base";
export type CreateForm = Record<CreateField, string>;
export type CloneField = "url" | "destination";
export type CloneForm = Record<CloneField, string>;

export type ManagerState = {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly mode: Mode;
  readonly inventory?: WorktreeInventory;
  readonly selected: number;
  readonly selectedPath: string | undefined;
  readonly cwd: string;
  readonly openMode: WorktreeOpenMode;
  readonly sourceWorkspaceId?: string;
  readonly sourceWorkspaceName?: string;
  readonly form: CreateForm;
  readonly cloneForm: CloneForm;
  readonly field: number;
  readonly caret: number;
  readonly removeTarget: string | undefined;
  readonly deleteBranch: boolean;
  readonly operation: Operation;
  readonly message: string;
  readonly loadToken: number;
  readonly statusToken: number;
  readonly operationToken: number;
};

export type Event =
  | { readonly type: "key"; readonly key: KeyName; readonly text?: string }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "context"; readonly cwd: string; readonly workspaceId?: string; readonly workspaceName?: string }
  | { readonly type: "context-failed"; readonly cwd: string }
  | { readonly type: "inventory"; readonly token: number; readonly inventory: WorktreeInventory; readonly notice: string; readonly preferredPath?: string; readonly cwd?: string }
  | { readonly type: "failure"; readonly token: number; readonly message: string }
  | { readonly type: "status"; readonly token: number; readonly path: string; readonly status: WorktreeStatus }
  | { readonly type: "statuses"; readonly token: number; readonly values: ReadonlyArray<{ readonly path: string; readonly status: WorktreeStatus }> }
  | { readonly type: "removed"; readonly token: number; readonly notice: string }
  | { readonly type: "opened"; readonly token: number }
  | { readonly type: "workspace-name"; readonly token: number; readonly name?: string };

export type Effect =
  | { readonly type: "resolve-context" }
  | { readonly type: "load"; readonly cwd: string; readonly token: number; readonly notice: string }
  | { readonly type: "load-statuses"; readonly inventory: WorktreeInventory; readonly token: number }
  | { readonly type: "fetch"; readonly cwd: string; readonly token: number }
  | { readonly type: "create"; readonly cwd: string; readonly token: number; readonly input: CreateWorktreeInput; readonly directory: string }
  | { readonly type: "clone"; readonly cwd: string; readonly token: number; readonly input: CloneRepositoryInput }
  | { readonly type: "remove"; readonly cwd: string; readonly token: number; readonly path: string; readonly deleteBranch: boolean }
  | { readonly type: "open"; readonly token: number; readonly root: string; readonly path: string; readonly mode: WorktreeOpenMode; readonly branch?: string }
  | { readonly type: "exit" };

export type Update = { readonly state: ManagerState; readonly effects: readonly Effect[] };
const fields: readonly CreateField[] = ["directory", "branch", "base"];
const cloneFields: readonly CloneField[] = ["url", "destination"];

export function initialState(size: { width: number; height: number }, cwd = ""): ManagerState {
  return {
    viewport: normalizedSize(size.width, size.height), mode: "list", selected: 0, selectedPath: undefined, cwd,
    openMode: "workspace", form: { directory: "", branch: "", base: "" }, cloneForm: { url: "", destination: "" }, field: 0, caret: 0,
    removeTarget: undefined, deleteBranch: false, operation: "discovering", message: "Discovering canonical worktree root…",
    loadToken: 0, statusToken: 0, operationToken: 0,
  };
}

export function selectedWorktree(state: ManagerState) {
  return state.inventory?.worktrees[state.selected];
}

export function isBusy(state: ManagerState): boolean {
  return !["idle", "error"].includes(state.operation);
}

export function update(state: ManagerState, event: Event): Update {
  if (event.type === "resize") return result({ ...state, viewport: normalizedSize(event.width, event.height) });
  if (event.type === "status" || event.type === "statuses") {
    if (event.token !== state.statusToken || !state.inventory) return result(state);
    const statuses = event.type === "status"
      ? new Map([[event.path, event.status]])
      : new Map(event.values.map(({ path, status }) => [path, status]));
    return result({
      ...state,
      inventory: {
        ...state.inventory,
        worktrees: state.inventory.worktrees.map((item) => {
          const status = statuses.get(item.path);
          return status ? { ...item, status } : item;
        }),
      },
    });
  }
  if (event.type === "context" || event.type === "context-failed") {
    if (state.operation !== "discovering") return result(state);
    const token = state.loadToken + 1;
    const next: ManagerState = {
      ...state, cwd: event.cwd, loadToken: token, operationToken: token,
      ...(event.type === "context" && event.workspaceId ? { sourceWorkspaceId: event.workspaceId } : {}),
      ...(event.type === "context" && event.workspaceName ? { sourceWorkspaceName: event.workspaceName } : {}),
    };
    return result(next, [{ type: "load", cwd: event.cwd, token, notice: "Ready" }]);
  }
  if (event.type === "inventory") {
    if (event.token !== state.operationToken) return result(state);
    const wanted = event.preferredPath ?? state.selectedPath ?? selectedWorktree(state)?.path;
    const found = wanted ? event.inventory.worktrees.findIndex((item) => item.path === wanted) : -1;
    const selected = found >= 0 ? found : Math.min(state.selected, Math.max(0, event.inventory.worktrees.length - 1));
    const statusToken = state.statusToken + 1;
    const selectedPath = event.inventory.worktrees[selected]?.path;
    return result({
      ...state, inventory: event.inventory, selected, ...(selectedPath ? { selectedPath } : { selectedPath: undefined }),
      ...(event.cwd ? { cwd: event.cwd } : {}),
      mode: "list", operation: "idle", message: event.notice, statusToken,
      form: event.notice === "Worktree created" ? { directory: "", branch: "", base: "" } : state.form,
      cloneForm: event.notice === "Repository cloned" ? { url: "", destination: "" } : state.cloneForm,
      field: event.notice === "Worktree created" || event.notice === "Repository cloned" ? 0 : state.field,
    }, [{ type: "load-statuses", inventory: event.inventory, token: statusToken }]);
  }
  if (event.type === "failure") {
    if (event.token !== state.operationToken) return result(state);
    return result({ ...state, operation: "error", message: sanitize(event.message) });
  }
  if (event.type === "removed") {
    if (event.token !== state.operationToken) return result(state);
    const token = Math.max(state.loadToken, state.operationToken) + 1;
    return result({ ...state, mode: "list", selected: 0, selectedPath: undefined, loadToken: token, operationToken: token, operation: "refreshing", message: event.notice }, [
      { type: "load", cwd: state.cwd, token, notice: event.notice },
    ]);
  }
  if (event.type === "opened") return event.token === state.operationToken ? result(state, [{ type: "exit" }]) : result(state);
  if (event.type === "workspace-name") {
    if (event.token !== state.operationToken) return result(state);
    return result(event.name ? { ...state, sourceWorkspaceName: event.name } : state);
  }
  return handleKey(state, event);
}

function handleKey(state: ManagerState, event: Extract<Event, { type: "key" }>): Update {
  if (event.key === "ctrl-c" || ((event.key === "escape" || event.text === "q") && isBusy(state))) return result(state, [{ type: "exit" }]);
  if (isBusy(state)) return result(state);
  if (state.mode === "create") return createKey(state, event);
  if (state.mode === "clone") return cloneKey(state, event);
  if (state.mode === "remove") return removeKey(state, event);
  if (event.key === "escape" || event.text === "q") return result(state, [{ type: "exit" }]);
  const items = state.inventory?.worktrees ?? [];
  if (event.key === "up" || event.text === "k") return select(state, state.selected - 1);
  if (event.key === "down" || event.text === "j") return select(state, state.selected + 1);
  if (event.text === "a") return result({ ...state, mode: "create", field: 0, caret: graphemes(state.form.directory).length, message: "Enter the new worktree details" });
  if (event.text === "c") return result({ ...state, mode: "clone", field: 0, caret: graphemes(state.cloneForm.url).length, message: "Clone directly into the canonical layout" });
  const selectedItem = items[state.selected];
  if (event.text === "d" && selectedItem) return result({ ...state, mode: "remove", removeTarget: selectedItem.path, deleteBranch: false });
  if (event.text === "m") {
    const mode = state.openMode === "workspace" ? "nested" : "workspace";
    return result({ ...state, openMode: mode, message: `Open mode: ${mode === "workspace" ? "standalone workspace" : "nested worktree"}` });
  }
  if (event.text === "r") return foreground(state, "refreshing", "Refreshing…", (token) => ({ type: "load", cwd: state.cwd, token, notice: "Refreshed" }));
  if (event.text === "f") return foreground(state, "fetching", "Fetching origin…", (token) => ({ type: "fetch", cwd: state.cwd, token }));
  const active = items[state.selected];
  if ((event.key === "enter" || event.text === "o") && active && state.inventory) {
    return foreground(state, "opening", "Opening in Herdr…", (token) => ({
      type: "open", token, root: state.inventory!.root.path, path: active.path, mode: state.openMode,
      ...(active.branch ? { branch: active.branch } : {}),
    }));
  }
  return result(state);
}

function createKey(state: ManagerState, event: Extract<Event, { type: "key" }>): Update {
  if (event.key === "escape") return result({ ...state, mode: "list", message: "Creation cancelled" });
  if (event.key === "tab" || event.key === "shift-tab" || event.key === "up" || event.key === "down") {
    const delta = event.key === "shift-tab" || event.key === "up" ? -1 : 1;
    const field = Math.max(0, Math.min(2, state.field + delta));
    return result({ ...state, field, caret: graphemes(state.form[fields[field]!]).length });
  }
  if (event.key === "enter") {
    const directory = state.form.directory.trim();
    return foreground(state, "creating", "Creating worktree…", (token) => ({
      type: "create", cwd: state.cwd, token, directory,
      input: { localDirectory: directory, ...(state.form.branch.trim() ? { branch: state.form.branch.trim() } : {}), ...(state.form.base.trim() ? { base: state.form.base.trim() } : {}) },
    }));
  }
  const name = fields[state.field]!;
  const parts = graphemes(state.form[name]);
  if (event.key === "left") return result({ ...state, caret: Math.max(0, state.caret - 1) });
  if (event.key === "right") return result({ ...state, caret: Math.min(parts.length, state.caret + 1) });
  if (event.key === "home") return result({ ...state, caret: 0 });
  if (event.key === "end") return result({ ...state, caret: parts.length });
  if (event.key === "backspace" && state.caret > 0) return setField(state, name, [...parts.slice(0, state.caret - 1), ...parts.slice(state.caret)].join(""), state.caret - 1);
  if (event.key === "delete" && state.caret < parts.length) return setField(state, name, [...parts.slice(0, state.caret), ...parts.slice(state.caret + 1)].join(""), state.caret);
  if (event.key === "character" && event.text) {
    const text = sanitize(event.text).replace(/[\r\n]/g, "");
    if (!text || [...text].some((char) => (char.codePointAt(0) ?? 0) < 32)) return result(state);
    const inserted = graphemes(text);
    return setField(state, name, [...parts.slice(0, state.caret), ...inserted, ...parts.slice(state.caret)].join(""), state.caret + inserted.length);
  }
  return result(state);
}

function cloneKey(state: ManagerState, event: Extract<Event, { type: "key" }>): Update {
  if (event.key === "escape") return result({ ...state, mode: "list", message: "Clone cancelled" });
  if (event.key === "tab" || event.key === "shift-tab" || event.key === "up" || event.key === "down") {
    const delta = event.key === "shift-tab" || event.key === "up" ? -1 : 1;
    const field = Math.max(0, Math.min(1, state.field + delta));
    return result({ ...state, field, caret: graphemes(state.cloneForm[cloneFields[field]!]).length });
  }
  if (event.key === "enter") {
    return foreground(state, "cloning", "Cloning repository…", (token) => ({
      type: "clone", cwd: state.cwd, token,
      input: {
        url: state.cloneForm.url.trim(),
        ...(state.cloneForm.destination.trim() ? { destination: state.cloneForm.destination.trim() } : {}),
      },
    }));
  }
  const name = cloneFields[state.field]!;
  const edited = editText(state.cloneForm[name], state.caret, event);
  return edited ? result({ ...state, cloneForm: { ...state.cloneForm, [name]: edited.value }, caret: edited.caret }) : result(state);
}

function removeKey(state: ManagerState, event: Extract<Event, { type: "key" }>): Update {
  if (event.key === "escape" || event.text === "n") return result({ ...state, mode: "list", removeTarget: undefined, message: "Removal cancelled" });
  if (event.text === "b") return result({ ...state, deleteBranch: !state.deleteBranch });
  if ((event.key === "enter" || event.text === "y") && state.removeTarget) return foreground(state, "removing", "Removing worktree…", (token) => ({
    type: "remove", cwd: state.cwd, token, path: state.removeTarget!, deleteBranch: state.deleteBranch,
  }));
  return result(state);
}

function select(state: ManagerState, requested: number): Update {
  const count = state.inventory?.worktrees.length ?? 0;
  const selected = Math.max(0, Math.min(Math.max(0, count - 1), requested));
  const selectedPath = state.inventory?.worktrees[selected]?.path;
  return result({ ...state, selected, ...(selectedPath ? { selectedPath } : { selectedPath: undefined }) });
}

function foreground(state: ManagerState, operation: Operation, message: string, make: (token: number) => Effect): Update {
  const token = state.operationToken + 1;
  return result({ ...state, operation, message, operationToken: token }, [make(token)]);
}
function setField(state: ManagerState, name: CreateField, value: string, caret: number): Update { return result({ ...state, form: { ...state.form, [name]: value }, caret }); }
function editText(value: string, caret: number, event: Extract<Event, { type: "key" }>): { value: string; caret: number } | undefined {
  const parts = graphemes(value);
  if (event.key === "left") return { value, caret: Math.max(0, caret - 1) };
  if (event.key === "right") return { value, caret: Math.min(parts.length, caret + 1) };
  if (event.key === "home") return { value, caret: 0 };
  if (event.key === "end") return { value, caret: parts.length };
  if (event.key === "backspace" && caret > 0) return { value: [...parts.slice(0, caret - 1), ...parts.slice(caret)].join(""), caret: caret - 1 };
  if (event.key === "delete" && caret < parts.length) return { value: [...parts.slice(0, caret), ...parts.slice(caret + 1)].join(""), caret };
  if (event.key === "character" && event.text) {
    const text = sanitize(event.text).replace(/[\r\n]/g, "");
    if (!text || [...text].some((char) => (char.codePointAt(0) ?? 0) < 32)) return undefined;
    const inserted = graphemes(text);
    return { value: [...parts.slice(0, caret), ...inserted, ...parts.slice(caret)].join(""), caret: caret + inserted.length };
  }
  return undefined;
}
function graphemes(value: string): string[] { return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(({ segment }) => segment); }
function normalizedSize(width: number, height: number) { return { width: Math.max(1, Math.floor(width || 80)), height: Math.max(1, Math.floor(height || 24)) }; }
function result(state: ManagerState, effects: readonly Effect[] = []): Update { return { state, effects }; }
