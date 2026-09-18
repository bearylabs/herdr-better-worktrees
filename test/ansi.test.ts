import assert from "node:assert/strict";
import test from "node:test";
import { cellWidth, encodeFrame, pad, sanitize, style, stripAnsi, truncate } from "../src/ui/ansi.js";

test("sanitizes untrusted terminal controls", () => {
  assert.equal(sanitize("safe\u001b[31m red\nnext\u0007"), "safe red next");
});

test("measures graphemes without dependencies", () => {
  assert.equal(cellWidth("ascii"), 5);
  assert.equal(cellWidth("e\u0301"), 1);
  assert.equal(cellWidth("界"), 2);
  assert.equal(cellWidth("👩‍💻"), 2);
  assert.equal(cellWidth("❤️"), 2);
  assert.equal(cellWidth("1️⃣"), 2);
  assert.equal(cellWidth(style.bold("界x")), 3);
});

test("truncates only at grapheme boundaries and pads by cells", () => {
  assert.equal(truncate("Ae\u0301界Z", 4), "Ae\u0301…");
  assert.equal(cellWidth(pad("界", 4)), 4);
  assert.equal(truncate("abc", 1), "…");
  assert.equal(stripAnsi(truncate(style.bold("abcd"), 3)), "ab…");
  assert.match(truncate(style.bold("abcd"), 3), /\u001b\[1m/);
  assert.equal(truncate("abc", 0), "");
});

test("encodes a non-scrolling synchronized complete frame without a blanking transition", () => {
  const output = encodeFrame(undefined, { width: 3, height: 2, rows: ["abc", "def"] });
  assert.match(output, /\u001b\[\?2026h\u001b\[H/);
  assert.doesNotMatch(output, /\?1049h|\[2J/);
  assert.equal(output.endsWith("\u001b[?2026l"), true);
  assert.equal(stripAnsi(output).endsWith("\n"), false);
});
