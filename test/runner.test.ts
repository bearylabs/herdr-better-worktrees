import assert from "node:assert/strict";
import test from "node:test";
import { NodeCommandRunner } from "../src/core/runner.js";

test("aborts a running child command", async () => {
  const controller = new AbortController();
  const running = new NodeCommandRunner(5_000).run(
    process.execPath,
    ["-e", "setTimeout(() => {}, 5_000)"],
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(running, (error: unknown) =>
    error instanceof Error && error.name === "AbortError");
});

test("terminates a child command after the configured timeout", async () => {
  const result = await new NodeCommandRunner(50).run(
    process.execPath,
    ["-e", "setTimeout(() => {}, 5_000)"],
  );
  assert.equal(result.killed, true);
  assert.equal(result.code, -1);
});
