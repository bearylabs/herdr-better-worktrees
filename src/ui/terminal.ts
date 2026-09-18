import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import { ESC, encodeFrame, type Frame } from "./ansi.js";
import type { KeyName } from "./model.js";

export type NormalizedKey = { readonly key: KeyName; readonly text?: string };
type SignalName = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGTSTP" | "SIGCONT";
type Listener = (...args: any[]) => void;

export interface ProcessHooks {
  readonly pid: number;
  exitCode?: number;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  kill(pid: number, signal: SignalName): unknown;
  exit?(code: number): unknown;
}

export interface Terminal {
  readonly size: { readonly width: number; readonly height: number };
  start(onKey: (key: NormalizedKey) => void, onResize: (width: number, height: number) => void, onStop: (reason: string) => void): void;
  paint(frame: Frame, immediate?: boolean): void;
  stop(): void;
}

export class TerminalSession implements Terminal {
  private started = false;
  private active = false;
  private wasRaw = false;
  private wasPaused = false;
  private previous: Frame | undefined;
  private scheduled: Frame | undefined;
  private blocked: Frame | undefined;
  private renderQueued = false;
  private outputBroken = false;
  private onKeyCallback: (key: NormalizedKey) => void = () => {};
  private onResizeCallback: (width: number, height: number) => void = () => {};
  private onStopCallback: (reason: string) => void = () => {};
  private readonly listeners: Array<[any, string, Listener]> = [];

  constructor(
    private readonly input: ReadStream,
    private readonly output: WriteStream,
    private readonly processHooks: ProcessHooks,
  ) {}

  get size() { return { width: this.output.columns || 80, height: this.output.rows || 24 }; }

  start(onKey: (key: NormalizedKey) => void, onResize: (width: number, height: number) => void, onStop: (reason: string) => void): void {
    if (this.started) return;
    if (!this.input.isTTY || !this.output.isTTY || typeof this.input.setRawMode !== "function") throw new Error("Worktree manager requires an interactive terminal");
    this.started = true;
    this.onKeyCallback = onKey; this.onResizeCallback = onResize; this.onStopCallback = onStop;
    this.wasRaw = Boolean(this.input.isRaw);
    this.wasPaused = this.input.isPaused();
    emitKeypressEvents(this.input);
    this.listen(this.input, "keypress", this.handleKeypress);
    this.listen(this.output, "resize", this.handleResize);
    this.listen(this.output, "drain", this.handleDrain);
    this.listen(this.output, "error", this.handleOutputError);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP", "SIGCONT"] as const) this.listen(this.processHooks, signal, (..._args: any[]) => this.handleSignal(signal));
    this.listen(this.processHooks, "exit", this.handleExit);
    this.listen(this.processHooks, "uncaughtException", this.handleFatal);
    this.listen(this.processHooks, "unhandledRejection", this.handleFatal);
    this.activate();
  }

  paint(frame: Frame, immediate = false): void {
    if (!this.started) return;
    if (immediate) { this.scheduled = undefined; this.writeFrame(frame); return; }
    this.scheduled = frame;
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      const latest = this.scheduled; this.scheduled = undefined;
      if (latest) this.writeFrame(latest);
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const [emitter, event, listener] of this.listeners.splice(0)) emitter.off(event, listener);
    this.deactivate();
    this.restoreInputActivity();
    this.previous = undefined; this.scheduled = undefined; this.blocked = undefined;
  }

  private activate(): void {
    if (this.active) return;
    this.active = true;
    try {
      this.input.setRawMode(true);
      this.input.resume();
    } catch (error) {
      this.active = false;
      try { this.input.setRawMode(this.wasRaw); } catch {}
      this.restoreInputActivity();
      throw error;
    }
  }
  private deactivate(): void {
    if (!this.active) return;
    this.active = false;
    if (!this.outputBroken) {
      try { this.output.write(`${ESC}?2026l${ESC}0m${ESC}?25h`); } catch { this.outputBroken = true; }
    }
    try { this.input.setRawMode(this.wasRaw); } catch {}
  }
  private restoreInputActivity(): void {
    try { if (this.wasPaused) this.input.pause(); else this.input.resume(); } catch {}
  }
  private writeFrame(frame: Frame): void {
    if (!this.active) return;
    if (this.blocked) { this.blocked = frame; return; }
    const encoded = encodeFrame(this.previous, frame);
    this.previous = frame;
    if (!this.output.write(encoded)) this.blocked = frame;
  }
  private readonly handleDrain = () => {
    if (!this.blocked) return;
    const frame = this.scheduled ?? this.blocked;
    this.blocked = undefined; this.scheduled = undefined;
    // The blocked write was accepted by Node; only repaint if a newer frame exists.
    if (frame !== this.previous) this.writeFrame(frame);
  };
  private readonly handleKeypress = (text: string | undefined, key: Record<string, unknown> | undefined) => {
    const normalized = normalizeKey(text, key);
    if (normalized) this.onKeyCallback(normalized);
  };
  private readonly handleResize = () => { const size = this.size; this.previous = undefined; this.onResizeCallback(size.width, size.height); };
  private readonly handleOutputError = (error: NodeJS.ErrnoException) => {
    // Never write terminal-reset bytes back to a stream that has already
    // failed: doing so can queue an unhandled second EPIPE after listeners go.
    this.outputBroken = true;
    if (error.code === "EPIPE") { this.onStopCallback("stdout EPIPE"); this.stop(); }
    else this.handleFatal(error);
  };
  private readonly handleExit = () => { this.stop(); };
  private readonly handleFatal = (_error: unknown) => {
    this.processHooks.exitCode = 1;
    this.onStopCallback("fatal terminal error");
    this.stop();
    this.processHooks.exit?.(1);
  };
  private handleSignal(signal: SignalName): void {
    if (signal === "SIGCONT") {
      this.activate(); this.previous = undefined; this.onResizeCallback(this.size.width, this.size.height);
      if (!this.listeners.some(([, event]) => event === "SIGTSTP")) this.listen(this.processHooks, "SIGTSTP", () => this.handleSignal("SIGTSTP"));
      return;
    }
    if (signal === "SIGTSTP") {
      this.deactivate();
      this.restoreInputActivity();
      // A custom signal handler prevents the operating system's default
      // suspension. Remove it before re-sending SIGTSTP; SIGCONT restores it.
      this.removeListeners("SIGTSTP");
      try { this.processHooks.kill(this.processHooks.pid, signal); } catch { this.processHooks.exitCode = 148; }
      return;
    }
    this.onStopCallback(signal);
    this.deactivate();
    this.stop();
    try { this.processHooks.kill(this.processHooks.pid, signal); } catch { this.processHooks.exitCode = 128 + signalNumber(signal); }
  }
  private listen(emitter: any, event: string, listener: Listener): void { emitter.on(event, listener); this.listeners.push([emitter, event, listener]); }
  private removeListeners(event: string): void {
    for (let index = this.listeners.length - 1; index >= 0; index--) {
      const entry = this.listeners[index];
      if (entry?.[1] !== event) continue;
      entry[0].off(entry[1], entry[2]);
      this.listeners.splice(index, 1);
    }
  }
}

export function normalizeKey(text: string | undefined, key: Record<string, unknown> | undefined): NormalizedKey | undefined {
  if (key?.ctrl === true && (key.name === "c" || text === "\u0003")) return { key: "ctrl-c" };
  const name = typeof key?.name === "string" ? key.name : "";
  if (name === "escape") return { key: "escape" };
  if (name === "return" || name === "enter") return { key: "enter" };
  if (name === "tab") return { key: key?.shift === true ? "shift-tab" : "tab" };
  if (["up", "down", "left", "right", "home", "end", "backspace", "delete"].includes(name)) return { key: name as KeyName };
  const sequence = typeof key?.sequence === "string" ? key.sequence : text;
  if (!sequence || sequence.startsWith("\u001b") || /[\u0000-\u001f\u007f]/u.test(sequence)) return undefined;
  return { key: "character", text: sequence };
}

function signalNumber(signal: SignalName): number { return ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15, SIGTSTP: 20, SIGCONT: 18 })[signal]; }
