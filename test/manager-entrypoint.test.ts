import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const managerUrl = pathToFileURL(resolve("src/manager.ts")).href;
const tsxUrl = import.meta.resolve("tsx");
const bootstrap = `
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
Object.defineProperty(process.stdout, "columns", { value: 90 });
Object.defineProperty(process.stdout, "rows", { value: 20 });
Object.defineProperty(process.stdin, "isRaw", { value: false, writable: true });
process.stdin.setRawMode = function (value) { this.isRaw = value; return this; };
await import(${JSON.stringify(managerUrl)});
`;

function runEntrypoint(
  cwd: string,
  input: string,
  ready: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", tsxUrl, "--input-type=module", "--eval", bootstrap], {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sent = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`manager entrypoint did not exit; stdout=${JSON.stringify(stdout.slice(-500))} stderr=${JSON.stringify(stderr)}`));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!sent && stdout.includes(ready)) {
        sent = true;
        child.stdin.write(input);
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

for (const [name, input] of [["q", "q"], ["Escape", "\u001b"], ["Ctrl-C", "\u0003"]] as const) {
  test(`manager entrypoint exits after ${name} without stdin closing`, async () => {
    const result = await runEntrypoint(process.cwd(), input, "Better Worktrees", {
      HERDR_BIN_PATH: join(process.cwd(), "does-not-exist"),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\?25h/, "cursor cleanup must precede process exit");
  });
}

test("manager entrypoint exits after a successful open", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "better-worktrees-entrypoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  const bare = join(root, ".bare");
  const worktree = join(root, "main");
  mkdirSync(seed);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: seed });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: seed });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: seed });
  writeFileSync(join(seed, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: seed });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: seed });
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  writeFileSync(join(root, ".git"), "gitdir: ./.bare\n");
  execFileSync("git", ["worktree", "add", "-q", worktree, "main"], { cwd: root });

  const herdr = join(root, "fake-herdr.mjs");
  const herdrLog = join(root, "herdr.log");
  writeFileSync(herdr, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "workspace" && args[1] === "get") console.log(JSON.stringify({ result: { workspace: { label: "development", number: 1 } } }));
else if (args[0] === "workspace" && args[1] === "list") console.log(JSON.stringify({ result: { workspaces: [] } }));
else if (args[0] === "pane" && args[1] === "list") console.log(JSON.stringify({ result: { panes: [] } }));
else console.log("{}");
`);
  chmodSync(herdr, 0o755);

  const result = await runEntrypoint(worktree, "\r", "Ready", {
    HERDR_BIN_PATH: herdr,
    FAKE_HERDR_LOG: herdrLog,
    BETTER_WORKTREES_SOURCE_WORKSPACE_ID: "source",
    HERDR_PLUGIN_ROOT: process.cwd(),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\?25h/, "successful open must clean the terminal before exit");
  const calls = await import("node:fs").then(({ readFileSync }) => readFileSync(herdrLog, "utf8"));
  assert.match(calls, /\["workspace","create"/);
});
