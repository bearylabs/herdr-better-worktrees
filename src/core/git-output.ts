import { failure, InvalidGitOutput, success, type Result } from "./domain.js";

export type ParsedGitWorktree = {
  readonly path: string;
  readonly head: string;
  readonly branch?: string;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  readonly lockedReason?: string;
  readonly prunableReason?: string;
};

type Draft = {
  path?: string;
  head?: string;
  branch?: string;
  isBare: boolean;
  isDetached: boolean;
  lockedReason?: string;
  prunableReason?: string;
};

export function parseGitWorktreePorcelain(output: string): Result<ReadonlyArray<ParsedGitWorktree>, InvalidGitOutput> {
  const records: ParsedGitWorktree[] = [];
  let draft = freshDraft();

  for (const field of output.split("\0")) {
    if (field === "") {
      if (draft.path !== undefined || draft.head !== undefined) {
        const record = completeDraft(draft);
        if (!record.ok) return record;
        records.push(record.value);
        draft = freshDraft();
      }
    } else if (field.startsWith("worktree ")) {
      draft.path = field.slice(9);
    } else if (field.startsWith("HEAD ")) {
      draft.head = field.slice(5);
    } else if (field.startsWith("branch refs/heads/")) {
      draft.branch = field.slice(18);
    } else if (field === "bare") {
      draft.isBare = true;
    } else if (field === "detached") {
      draft.isDetached = true;
    } else if (field === "locked" || field.startsWith("locked ")) {
      draft.lockedReason = field.slice(6).trim();
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      draft.prunableReason = field.slice(8).trim();
    }
  }

  if (draft.path !== undefined || draft.head !== undefined) {
    const record = completeDraft(draft);
    if (!record.ok) return record;
    records.push(record.value);
  }
  return success(records);
}

export function countStatusChanges(output: string): number {
  return output === "" ? 0 : output.split("\n").filter(Boolean).length;
}

function freshDraft(): Draft {
  return { isBare: false, isDetached: false };
}

function completeDraft(draft: Draft): Result<ParsedGitWorktree, InvalidGitOutput> {
  if (!draft.path) return failure(new InvalidGitOutput("record is missing its worktree path"));
  if (!draft.isBare && !draft.head) return failure(new InvalidGitOutput(`record for ${draft.path} is missing HEAD`));
  return success({
    path: draft.path,
    head: draft.head ?? "",
    isBare: draft.isBare,
    isDetached: draft.isDetached,
    ...(draft.branch === undefined ? {} : { branch: draft.branch }),
    ...(draft.lockedReason === undefined ? {} : { lockedReason: draft.lockedReason }),
    ...(draft.prunableReason === undefined ? {} : { prunableReason: draft.prunableReason }),
  });
}
