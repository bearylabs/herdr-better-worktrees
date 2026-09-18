import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TerminalSession, normalizeKey, type ProcessHooks } from "../src/ui/terminal.js";

class FakeInput extends EventEmitter {
  isTTY = true; isRaw = false; paused = true; rawCalls: boolean[] = [];
  setRawMode(value: boolean) { this.isRaw = value; this.rawCalls.push(value); return this; }
  isPaused() { return this.paused; }
  resume() { this.paused = false; return this; }
  pause() { this.paused = true; return this; }
}
class FakeOutput extends EventEmitter {
  isTTY = true; columns = 80; rows = 24; writes: string[] = []; backpressure = false; throwWrites = false;
  write(value: string) { if (this.throwWrites) throw new Error("write failed"); this.writes.push(value); return !this.backpressure; }
}
class FakeProcess extends EventEmitter implements ProcessHooks {
  pid = 123; exitCode: number | undefined; kills: string[] = [];
  kill(_pid: number, signal: any) { this.kills.push(signal); return true; }
}

test("normalizes readline keys and rejects control sequences", () => {
  assert.deepEqual(normalizeKey("j", { name: "j", sequence: "j" }), { key: "character", text: "j" });
  assert.deepEqual(normalizeKey(undefined, { name: "up", sequence: "\u001b[A" }), { key: "up" });
  assert.deepEqual(normalizeKey("\u0003", { name: "c", ctrl: true }), { key: "ctrl-c" });
  assert.equal(normalizeKey(undefined, { sequence: "\u001b[200~" }), undefined);
});

test("recognizes a standalone Escape without readline's half-second delay", async () => {
  const input = new FakeInput(); const output = new FakeOutput(); const hooks = new FakeProcess();
  const terminal = new TerminalSession(input as any, output as any, hooks);
  const escape = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Escape was not recognized promptly")), 100);
    terminal.start((key) => {
      if (key.key === "escape") { clearTimeout(timeout); resolve(); }
    }, () => {}, () => {});
  });
  input.emit("data", Buffer.from("\u001b"));
  try { await escape; } finally { terminal.stop(); }
});

test("paints directly into the popup viewport and restores terminal state once", () => {
  const input = new FakeInput(); const output = new FakeOutput(); const hooks = new FakeProcess();
  const terminal = new TerminalSession(input as any, output as any, hooks);
  terminal.start(() => {}, () => {}, () => {});
  assert.deepEqual(input.rawCalls, [true]);
  assert.equal(output.writes.length, 0);
  terminal.paint({ width: 3, height: 1, rows: ["one"] }, true);
  assert.equal(output.writes.length, 1);
  assert.match(output.writes[0]!, /^\u001b\[\?2026h\u001b\[H.*one/s);
  assert.doesNotMatch(output.writes[0]!, /\?1049h|\[2J/);
  terminal.stop(); terminal.stop();
  assert.deepEqual(input.rawCalls, [true, false]);
  assert.equal(output.writes.filter((value) => value.includes("?25h")).length, 1);
  assert.equal(input.paused, true);
});

test("rolls back terminal state when the first atomic frame fails", () => {
  const input = new FakeInput(); const output = new FakeOutput(); const hooks = new FakeProcess();
  const terminal = new TerminalSession(input as any, output as any, hooks);
  terminal.start(() => {}, () => {}, () => {});
  output.throwWrites = true;
  assert.throws(() => terminal.paint({ width: 3, height: 1, rows: ["one"] }, true), /write failed/);
  terminal.stop();
  assert.deepEqual(input.rawCalls, [true, false]);
  assert.equal(input.paused, true);
});

test("coalesces renders and retains the latest under backpressure", async () => {
  const input = new FakeInput(); const output = new FakeOutput(); const hooks = new FakeProcess();
  const terminal = new TerminalSession(input as any, output as any, hooks);
  terminal.start(() => {}, () => {}, () => {});
  output.backpressure = true;
  terminal.paint({ width: 3, height: 1, rows: ["one"] }, true);
  terminal.paint({ width: 3, height: 1, rows: ["two"] });
  terminal.paint({ width: 3, height: 1, rows: ["new"] });
  await new Promise((resolve) => setImmediate(resolve));
  output.backpressure = false; output.emit("drain");
  assert.match(output.writes.at(-1)!, /new/);
});

test("resize, EPIPE and terminating signals invoke lifecycle callbacks", () => {
  const input = new FakeInput(); const output = new FakeOutput(); const hooks = new FakeProcess();
  const resized: number[][] = []; const reasons: string[] = [];
  const terminal = new TerminalSession(input as any, output as any, hooks);
  terminal.start(() => {}, (w, h) => resized.push([w, h]), (reason) => reasons.push(reason));
  output.columns = 100; output.rows = 30; output.emit("resize");
  assert.deepEqual(resized, [[100, 30]]);
  output.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
  assert.deepEqual(reasons, ["stdout EPIPE"]);
  assert.deepEqual(input.rawCalls, [true, false]);

  const input2 = new FakeInput(); const output2 = new FakeOutput(); const hooks2 = new FakeProcess();
  const terminal2 = new TerminalSession(input2 as any, output2 as any, hooks2);
  terminal2.start(() => {}, () => {}, () => {}); hooks2.emit("SIGTERM");
  assert.deepEqual(hooks2.kills, ["SIGTERM"]);
});

test("suspend restores and continue re-enters terminal", () => {
  const input = new FakeInput(); const output = new FakeOutput(); const hooks = new FakeProcess();
  const terminal = new TerminalSession(input as any, output as any, hooks);
  terminal.start(() => {}, () => {}, () => {});
  hooks.emit("SIGTSTP");
  assert.equal(input.paused, true);
  hooks.emit("SIGCONT");
  assert.equal(input.paused, false);
  assert.deepEqual(input.rawCalls, [true, false, true]);
  assert.deepEqual(hooks.kills, ["SIGTSTP"]);
  terminal.stop();
});
