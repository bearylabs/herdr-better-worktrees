import { spawn } from "node:child_process";

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly killed: boolean;
};

export type RunOptions = {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export interface CommandRunner {
  run(command: string, args: ReadonlyArray<string>, options?: RunOptions): Promise<CommandResult>;
}

export class NodeCommandRunner implements CommandRunner {
  constructor(private readonly defaultTimeoutMs = 300_000) {}

  run(command: string, args: ReadonlyArray<string>, options?: RunOptions): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
      const child = spawn(command, [...args], {
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(timeoutMs <= 0 ? {} : { timeout: timeoutMs }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ stdout, stderr, code: code ?? -1, killed: signal !== null }));
    });
  }
}
