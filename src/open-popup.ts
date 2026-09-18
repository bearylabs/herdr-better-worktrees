import { HerdrClient } from "./herdr-client.js";
import { NodeCommandRunner } from "./core/runner.js";

const client = new HerdrClient(new NodeCommandRunner());

try {
  // Open the pane before doing any context lookup. The manager resolves the
  // source pane and workspace after its first render so the popup chrome and
  // loading state are visible immediately.
  await client.openManagerPopup(process.cwd(), {
    ...(process.env.HERDR_PANE_ID ? { paneId: process.env.HERDR_PANE_ID } : {}),
    ...(process.env.HERDR_WORKSPACE_ID ? { workspaceId: process.env.HERDR_WORKSPACE_ID } : {}),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
