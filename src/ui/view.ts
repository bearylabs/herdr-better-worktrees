import type { WorktreeRecord } from "../core/domain.js";
import { cellWidth, pad, sanitize, style, truncate, type Frame } from "./ansi.js";
import { isBusy, selectedWorktree, type ManagerState } from "./model.js";

export function render(state: ManagerState): Frame {
  const { width, height } = state.viewport;
  const rows: string[] = [];
  const busy = isBusy(state);
  if (height <= 2) {
    rows.push(fit("◆ Better Worktrees", width));
    if (height === 2) rows.push(fit(`${busy ? "◌" : messageIcon(state.message)} ${sanitize(state.message)}`, width, busy));
    return { width, height, rows };
  }
  const root = state.inventory ? `  /  ${sanitize(state.inventory.root.name)}` : "";
  const linked = busy ? "◌ Working…" : `● ${state.inventory?.worktrees.length ?? 0} linked`;
  rows.push(borderLine("╭", "─", "╮", width));
  rows.push(sideBySide(`${style.bold("◆ Better Worktrees")}${style.dim(root)}`, style.bold(linked), width));
  rows.push(borderLine("╰", "─", "╯", width));

  const bodyHeight = Math.max(0, height - 6);
  let cursor: { row: number; column: number } | undefined;
  if (bodyHeight > 0) {
    if (state.mode === "create") {
      const view = createView(state, width, bodyHeight, rows.length);
      rows.push(...view.rows); cursor = view.cursor;
    } else if (state.mode === "remove" && state.removeTarget) rows.push(...removeView(state, width, bodyHeight));
    else rows.push(...listView(state, width, bodyHeight));
  }
  while (rows.length < Math.max(0, height - 2)) rows.push(" ".repeat(width));
  if (height >= 2) rows.push(fit(`${busy ? "◌" : messageIcon(state.message)} ${sanitize(state.message)}`, width, busy));
  if (height >= 1) rows.push(fit(shortcuts(state.mode), width));
  const fitted = rows.slice(0, height).map((row) => fitAnsi(row, width));
  while (fitted.length < height) fitted.push(" ".repeat(width));
  return { width, height, rows: fitted, ...(cursor && cursor.row < height ? { cursor } : {}) };
}

function listView(state: ManagerState, width: number, height: number): string[] {
  if (!state.inventory) return box("LOADING", ["", style.bold("◌  Loading worktrees"), style.dim("Reading the canonical Git worktree inventory…")], width, height);
  if (!state.inventory.worktrees.length) return box("WORKTREES", ["", style.bold("◇  No linked worktrees"), style.dim("Press a to create your first worktree.")], width, height);
  if (width < 88) return listPanel(state, width, height, true);
  const leftWidth = Math.max(1, Math.floor(width * 0.58));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const left = listPanel(state, leftWidth, height, false);
  const right = detailsPanel(selectedWorktree(state)!, state.openMode, rightWidth, height);
  return Array.from({ length: height }, (_, index) => `${left[index] ?? " ".repeat(leftWidth)} ${right[index] ?? " ".repeat(rightWidth)}`);
}

function listPanel(state: ManagerState, width: number, height: number, compact: boolean): string[] {
  const inventory = state.inventory!;
  const capacity = Math.max(1, Math.min(11, height - 4));
  const start = Math.max(0, Math.min(state.selected - Math.floor(capacity / 2), Math.max(0, inventory.worktrees.length - capacity)));
  const visible = inventory.worktrees.slice(start, start + capacity);
  const mode = state.openMode === "workspace" ? "workspace" : "nested";
  const heading = compact ? `WORKTREES  ${mode}  •  ${state.selected + 1} / ${inventory.worktrees.length}` : `WORKTREES  ${state.selected + 1} / ${inventory.worktrees.length}`;
  const inner = Math.max(0, width - 2);
  const lines = visible.map((item, offset) => worktreeRow(item, start + offset === state.selected, inner));
  if (inventory.worktrees.length > capacity && lines.length) {
    const indicators = `${start > 0 ? "↑ more" : ""}${start > 0 && start + visible.length < inventory.worktrees.length ? "  " : ""}${start + visible.length < inventory.worktrees.length ? "↓ more" : ""}`;
    lines[lines.length - 1] = sideBySide(lines[lines.length - 1]!, style.dim(indicators), inner);
  }
  return box(heading, lines, width, height);
}

function worktreeRow(item: WorktreeRecord, selected: boolean, width: number): string {
  const marker = item.isCurrent ? "●" : " ";
  const left = ` ${selected ? "›" : " "} ${marker} ${sanitize(item.localDirectory)}  ${sanitize(item.branch ?? "detached")}`;
  const status = statusText(item);
  const right = truncate(status, Math.min(cellWidth(status), width));
  const leftWidth = Math.max(0, width - cellWidth(right) - 1);
  const plain = `${pad(truncate(left, leftWidth), leftWidth)}${width > cellWidth(right) ? " " : ""}${right}`;
  return selected ? style.inverseBold(pad(plain, width)) : pad(plain, width);
}

function detailsPanel(item: WorktreeRecord, mode: string, width: number, height: number): string[] {
  const lines = [
    style.bold(sanitize(item.localDirectory)),
    detail("Branch", item.branch ?? "detached HEAD"),
    detail("Commit", item.head.slice(0, 12)),
    detail("Status", statusText(item)),
    detail("Open as", mode === "workspace" ? "standalone workspace" : "nested worktree"),
    detail("Current", item.isCurrent ? "yes" : "no"),
    ...(item.lockedReason !== undefined ? [detail("Locked", item.lockedReason || "yes")] : []),
    ...(item.prunableReason !== undefined ? [detail("Prunable", item.prunableReason || "yes")] : []),
    "", style.dim("PATH"), sanitize(item.path),
  ];
  return box("DETAILS", lines, width, height);
}

function createView(state: ManagerState, width: number, height: number, rowOffset: number): { rows: string[]; cursor?: { row: number; column: number } } {
  const names = ["directory", "branch", "base"] as const;
  const labels = ["Directory", "Branch (optional)", "Base (optional)"];
  const hints = ["topic-name", state.form.directory.trim() || "same as directory", "origin/main"];
  const lines: string[] = [""];
  let cursor: { row: number; column: number } | undefined;
  for (let index = 0; index < names.length; index++) {
    const value = sanitize(state.form[names[index]!]);
    const prefix = `${index === state.field ? "›" : " "} ${labels[index]!.padEnd(18)} │ `;
    const shown = value || hints[index]!;
    lines.push(`${index === state.field ? style.bold(prefix) : prefix}${value ? shown : style.dim(shown)}`);
    if (index === state.field) {
      const before = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].slice(0, state.caret).map(({ segment }) => segment).join("");
      const boxRow = lines.length;
      // Do not expose a cursor on a clipped field (or on the bottom border).
      if (width >= 3 && boxRow < height - 1) {
        cursor = { row: rowOffset + boxRow, column: Math.max(1, Math.min(width - 2, 1 + cellWidth(prefix) + cellWidth(before))) };
      }
    }
  }
  lines.push("", style.dim("Branches are reused locally, tracked from origin, or created from the optional base."));
  return { rows: box("＋ CREATE WORKTREE", lines, width, height), ...(cursor ? { cursor } : {}) };
}

function removeView(state: ManagerState, width: number, height: number): string[] {
  const item = state.inventory?.worktrees.find((candidate) => candidate.path === state.removeTarget);
  if (!item) return box("− REMOVE WORKTREE", ["Selected worktree is no longer available."], width, height);
  return box("− REMOVE WORKTREE", [
    "", detail("Directory", item.localDirectory), detail("Branch", item.branch ?? "detached"), detail("Status", statusText(item)), detail("Path", item.path), "",
    `${style.bold("› Branch cleanup")} │ ${state.deleteBranch ? "☑ delete merged local branch" : "☐ delete merged local branch"}  ${style.dim("(b to toggle)")}`,
    "", style.dim("The worktree directory will be removed from the linked inventory."), style.bold("Press enter or y to confirm removal."),
  ], width, height);
}

function box(title: string, lines: readonly string[], width: number, height: number): string[] {
  if (height <= 0) return [];
  if (width <= 1) return Array.from({ length: height }, () => " ".repeat(width));
  const topText = truncate(` ${title} `, Math.max(0, width - 2));
  const output = [`╭${topText}${"─".repeat(Math.max(0, width - 2 - cellWidth(topText)))}╮`];
  for (let index = 0; index < height - 2; index++) output.push(`│${fitAnsi(lines[index] ?? "", width - 2)}│`);
  if (height > 1) output.push(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
  return output.slice(0, height);
}

function statusText(item: WorktreeRecord): string {
  if (item.status.kind === "loading") return "◌ checking";
  if (item.status.kind === "clean") return "✓ clean";
  if (item.status.kind === "dirty") return `● ${item.status.changedFileCount} changed`;
  return "! unavailable";
}
function detail(label: string, value: string): string { return `${style.dim(label.padEnd(10))}${sanitize(value)}`; }
function borderLine(left: string, fill: string, right: string, width: number): string { return width <= 1 ? fill.repeat(width) : left + fill.repeat(width - 2) + right; }
function sideBySide(left: string, right: string, width: number): string {
  const available = Math.max(0, width - cellWidth(right));
  const cleanLeft = cellWidth(left) <= available ? left : truncate(left, available);
  return `${cleanLeft}${" ".repeat(Math.max(0, width - cellWidth(cleanLeft) - cellWidth(right)))}${right}`;
}
function fit(value: string, width: number, strong = false): string { const clean = pad(truncate(sanitize(value), width), width); return strong ? style.bold(clean) : clean; }
function fitAnsi(value: string, width: number): string {
  if (cellWidth(value) > width) return pad(truncate(value, width), width);
  return value + " ".repeat(Math.max(0, width - cellWidth(value)));
}
function messageIcon(message: string): string { const lower = message.toLowerCase(); return lower.includes("failed") || lower.includes("error") || message.startsWith("No canonical") ? "!" : /^(ready|refreshed|fetched|worktree)/i.test(message) ? "✓" : "•"; }
function shortcuts(mode: ManagerState["mode"]): string {
  return mode === "list" ? "↑↓ / jk move  enter / o open  m mode  a add  d remove  f fetch  r refresh  esc / q close"
    : mode === "create" ? "tab / ↑↓ fields  enter create  esc cancel"
      : "enter / y confirm  b branch cleanup  esc / n cancel";
}
