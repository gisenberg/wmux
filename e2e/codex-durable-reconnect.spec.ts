import { awaitAppShell, expect, test, type APIRequestContext, type E2eWorkspace, type Page } from "./fixtures";
import type { TestInfo } from "@playwright/test";

interface CodexChallenge {
  receipt: string;
  marker: string;
}

const runningMarker = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

const lifecycle = async (
  request: APIRequestContext,
  input: {
    sessionId: string;
    receipt: string;
    turnId: string;
    sequence: number;
    state: "active" | "attention" | "completed";
    attention: null | "input";
  },
): Promise<void> => {
  const response = await request.post("/api/codex-bindings/lifecycle", { data: input });
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ accepted: true });
};

const openWorkspaceSidebar = async (page: Page, mobile: boolean): Promise<void> => {
  if (mobile) {
    await page.getByRole("banner", { name: "Mobile session controls" })
      .getByRole("button", { name: "Open workspaces and hosts" }).click();
  }
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toBeVisible();
};

const screenshotSidebar = async (page: Page, testInfo: TestInfo): Promise<void> => {
  // Keep the terminal, where the fixture marker was emitted, out of artifacts.
  await page.getByRole("complementary", { name: "Workspace navigation" }).screenshot({
    path: testInfo.outputPath("codex-durable-reattached-sidebar.png"),
    animations: "disabled",
  });
};

const resolveStatus = async (request: APIRequestContext, sessionId: string, receipt: string): Promise<number> =>
  (await request.post("/api/codex-bindings/resolve", { data: { sessionId, receipt } })).status();

const emitMarkerSafely = async (
  request: APIRequestContext,
  paneId: string,
  marker: string,
): Promise<void> => {
  // The marker came from the fixture server, but do not execute it as a shell
  // command. It is emitted as separately quoted printf data and never appears
  // in an assertion or test message.
  const parts = [marker.slice(0, 2), marker.slice(2, 7), marker.slice(7)];
  const command = `printf '%s%s%s' '${parts[0]}' '${parts[1]}' '${parts[2]}'\r`;
  const response = await request.post(`/api/panes/${paneId}/input`, {
    data: { data: command, cols: 100, rows: 32 },
  });
  expect(response.ok()).toBeTruthy();
};

// This is a local isolated tmux/browser reconnect regression. It exercises a
// durable pane and receipt route, but deliberately does not launch Codex or an
// observer; native runtime behavior remains covered elsewhere.
test("retains a live Codex receipt when every browser viewer reconnects to a durable pane", async ({
  page,
  request,
  createReadyWorkspace,
}, testInfo) => {
  test.skip(!["chromium", "mobile-chromium"].includes(testInfo.project.name), "Chromium durable-pane coverage");
  test.setTimeout(90_000);
  const mobile = testInfo.project.name === "mobile-chromium";
  const suffix = `${testInfo.project.name}-${Date.now()}`.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase();
  const machineId = `codex-durable-${suffix}`;
  const sessionId = `codex-durable-session-${suffix}`;
  const turnId = `codex-durable-turn-${suffix}`;
  let workspace: E2eWorkspace | undefined;

  try {
    const createdMachine = await request.post("/api/machines", {
      data: { id: machineId, name: "Codex durable fixture", kind: "local", shell: "/bin/sh", sessionBackend: "tmux" },
    });
    expect(createdMachine.ok()).toBeTruthy();
    workspace = await createReadyWorkspace({ machineId });
    const tab = workspace.tabs[0]!;
    const paneId = tab.panes[0]!.id;
    const route = `/workspaces/${workspace.id}/tabs/${tab.id}`;

    // The first browser viewer may refresh an idle durable client before any
    // binding exists. Establish the receipt only after that viewer is attached.
    await page.goto(route);
    await awaitAppShell(page);
    await openWorkspaceSidebar(page, mobile);
    // A configured preference can fall back to raw PTY. Require the live
    // startup report so this test cannot pass without exercising tmux.
    await expect.poll(async () => {
      const response = await request.get("/api/doctor");
      expect(response.ok()).toBeTruthy();
      const report = await response.json() as { panes: Array<{ paneId: string; capabilitySource?: string; transport: string; restartDurable: boolean }> };
      const pane = report.panes.find(candidate => candidate.paneId === paneId);
      return pane?.capabilitySource === "live" && pane.transport === "local-multiplexer" && pane.restartDurable;
    }).toBe(true);

    const issued = await request.post("/api/codex-bindings", { data: { sessionId, turnId } });
    expect(issued.ok()).toBeTruthy();
    const challenge = await issued.json() as CodexChallenge;
    await emitMarkerSafely(request, paneId, challenge.marker);
    await expect.poll(() => resolveStatus(request, sessionId, challenge.receipt)).toBe(200);

    await lifecycle(request, {
      sessionId, receipt: challenge.receipt, turnId, sequence: 1, state: "active", attention: null,
    });
    const sidebarRow = page.locator(`a[role="treeitem"][href^="/workspaces/${workspace.id}/"]`);
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "running");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", runningMarker);

    // Drop every pane viewer, then make this page the fresh viewer. The durable
    // tmux process may need a client refresh, but a live receipt must survive.
    await page.goto("about:blank");
    await page.waitForTimeout(300);
    await page.goto(route);
    await awaitAppShell(page);
    await openWorkspaceSidebar(page, mobile);
    await expect.poll(() => resolveStatus(request, sessionId, challenge.receipt)).toBe(200);
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "running");
    const firstMarker = await sidebarRow.getAttribute("data-agent-marker");
    await expect.poll(() => sidebarRow.getAttribute("data-agent-marker")).not.toBe(firstMarker);
    await screenshotSidebar(page, testInfo);

    await lifecycle(request, {
      sessionId, receipt: challenge.receipt, turnId, sequence: 2, state: "attention", attention: "input",
    });
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "waiting");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", "?");

    await lifecycle(request, {
      sessionId, receipt: challenge.receipt, turnId, sequence: 3, state: "active", attention: null,
    });
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "running");

    await lifecycle(request, {
      sessionId, receipt: challenge.receipt, turnId, sequence: 4, state: "completed", attention: null,
    });
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "completed");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", "✓");

    const closeWorkspace = await request.delete(`/api/workspaces/${workspace.id}`);
    expect(closeWorkspace.ok()).toBeTruthy();
    await expect.poll(() => resolveStatus(request, sessionId, challenge.receipt)).toBe(404);
    workspace = undefined;
  } finally {
    if (workspace) await request.delete(`/api/workspaces/${workspace.id}`).catch(() => undefined);
    await request.delete(`/api/machines/${machineId}`).catch(() => undefined);
  }
});
