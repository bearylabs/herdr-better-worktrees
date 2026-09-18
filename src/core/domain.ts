export type Result<T, E extends Error = WorktreeError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const success = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const failure = <E extends Error>(error: E): Result<never, E> => ({ ok: false, error });

export type WorktreeRoot = {
  readonly path: string;
  readonly commonDirectory: string;
  readonly name: string;
};

export type WorktreeStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "clean" }
  | { readonly kind: "dirty"; readonly changedFileCount: number }
  | { readonly kind: "unavailable"; readonly reason: string };

export type WorktreeRecord = {
  readonly path: string;
  readonly localDirectory: string;
  readonly head: string;
  readonly branch?: string;
  readonly isDetached: boolean;
  readonly isCurrent: boolean;
  readonly lockedReason?: string;
  readonly prunableReason?: string;
  readonly status: WorktreeStatus;
};

export type WorktreeInventory = {
  readonly root: WorktreeRoot;
  readonly worktrees: ReadonlyArray<WorktreeRecord>;
};

export type CreateWorktreeInput = {
  readonly localDirectory: string;
  readonly branch?: string;
  readonly base?: string;
};

export type CloneRepositoryInput = {
  readonly url: string;
  readonly destination?: string;
};

export type InitializeRepositoryInput = {
  readonly destination: string;
  readonly initialBranch?: string;
};

export type RemoveWorktreeInput = {
  readonly path: string;
  readonly branchCleanup: "keep" | "delete-merged";
};

export type BranchCleanupOutcome =
  | { readonly kind: "kept" }
  | { readonly kind: "deleted"; readonly branch: string }
  | { readonly kind: "retained"; readonly branch: string; readonly reason: string };

export type WorktreeError =
  | CanonicalRootNotFound
  | GitCommandFailed
  | InvalidGitOutput
  | InvalidInput
  | WorktreeNotFound
  | UnsafeRemoval;

export class CanonicalRootNotFound extends Error {
  readonly kind = "CanonicalRootNotFound";
  constructor(readonly cwd: string, override readonly cause?: unknown) {
    super(`No canonical .bare worktree root found from ${cwd}`);
  }
}

export class GitCommandFailed extends Error {
  readonly kind = "GitCommandFailed";
  constructor(
    readonly operation: string,
    readonly stderr: string,
    readonly exitCode: number,
    override readonly cause?: unknown,
  ) {
    super(`Git command failed during ${operation}: ${stderr.trim() || `exit ${exitCode}`}`);
  }
}

export class InvalidGitOutput extends Error {
  readonly kind = "InvalidGitOutput";
  constructor(readonly reason: string) {
    super(`Invalid Git worktree output: ${reason}`);
  }
}

export class InvalidInput extends Error {
  readonly kind = "InvalidInput";
  constructor(readonly field: string, readonly value: string, readonly reason: string) {
    super(`Invalid ${field}: ${reason}: ${value}`);
  }
}

export class WorktreeNotFound extends Error {
  readonly kind = "WorktreeNotFound";
  constructor(readonly path: string) {
    super(`Worktree not found: ${path}`);
  }
}

export class UnsafeRemoval extends Error {
  readonly kind = "UnsafeRemoval";
  constructor(readonly reason: string) {
    super(reason);
  }
}
