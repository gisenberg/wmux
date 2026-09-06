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
    state: "active" | "attention" | "completed" | "unknown";
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

const screenshotSidebar = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  await page.getByRole("complementary", { name: "Workspace navigation" }).screenshot({
    path: testInfo.outputPath(name),
    animations: "disabled",
  });
};

// This is browser-fixture coverage of the receipt-bound wmux lifecycle route.
// It deliberately does not start a Codex CLI or observer and therefore is not
// evidence of a native Codex runtime session.
test("renders receipt-bound Codex lifecycle states in the desktop and mobile sidebars", async ({
  page,
  request,
  createReadyWorkspace,
}, testInfo) => {
  test.skip(!["chromium", "mobile-chromium"].includes(testInfo.project.name), "Chromium canvas/sidebar coverage");
  test.setTimeout(90_000);
  const mobile = testInfo.project.name === "mobile-chromium";
  const suffix = `${testInfo.project.name}-${Date.now()}`.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase();
  const sessionId = `codex-sidebar-session-${suffix}`;
  const turnId = `codex-sidebar-turn-${suffix}`;
  let workspace: E2eWorkspace | undefined;
  let busyWorkspace: E2eWorkspace | undefined;

  try {
    workspace = await createReadyWorkspace();
    const tab = workspace.tabs[0]!;
    const paneId = tab.panes[0]!.id;
    const issued = await request.post("/api/codex-bindings", { data: { sessionId, turnId } });
    expect(issued.ok()).toBeTruthy();
    const challenge = await issued.json() as CodexChallenge;

    // Keep the visible binding marker confined to the fixture pane. It is never
    // put in a test message, browser screenshot, or captured terminal output.
    const injected = await request.post(`/api/panes/${paneId}/input`, {
      data: { data: `${challenge.marker}\r`, cols: 100, rows: 32 },
    });
    expect(injected.ok()).toBeTruthy();
    await expect.poll(async () => {
      const resolved = await request.post("/api/codex-bindings/resolve", {
        data: { sessionId, receipt: challenge.receipt },
      });
      return resolved.status();
    }).toBe(200);

    await lifecycle(request, {
      sessionId, receipt: challenge.receipt, turnId, sequence: 1, state: "unknown", attention: null,
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`/workspaces/${workspace.id}/tabs/${tab.id}`);
    await awaitAppShell(page);
    await openWorkspaceSidebar(page, mobile);
    const sidebarRow = page.locator(`a[role="treeitem"][href^="/workspaces/${workspace.id}/"]`);
    await expect(sidebarRow).toHaveAttribute("data-agent-name", "codex");
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "stale");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", "!");
    await expect(sidebarRow).toHaveAccessibleName(/codex status unknown/);
    await screenshotSidebar(page, testInfo, "codex-initial-unknown-sidebar.png");

    // Recent history is not the current-state projection. More than 300 events
    // in another pane must not erase this untouched diagnostic, either through
    // event deltas or after a fresh bootstrap on reload.
    busyWorkspace = await createReadyWorkspace();
    const busyPaneId = busyWorkspace.tabs[0]!.panes[0]!.id;
    for (let index = 0; index < 305; index++) {
      const event = await request.post("/api/agent-events", {
        data: { paneId: busyPaneId, agent: "opencode", status: "updated", summary: `fixture activity ${index}` },
      });
      expect(event.ok()).toBeTruthy();
    }
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "stale");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", "!");
    await page.reload();
    await awaitAppShell(page);
    if (!await page.getByRole("complementary", { name: "Workspace navigation" }).isVisible()) {
      await openWorkspaceSidebar(page, mobile);
    }
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "stale");
    await expect(sidebarRow).toHaveAccessibleName(/codex status unknown/);
    await screenshotSidebar(page, testInfo, "codex-retained-unknown-sidebar.png");

    await lifecycle(request, {
      sessionId, receipt: challenge.receipt, turnId, sequence: 2, state: "active", attention: null,
    });
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "running");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", runningMarker);
    await expect(sidebarRow).toHaveAccessibleName(/codex working, workspace 1\/1 pane active/);
    const firstRunningMarker = await sidebarRow.getAttribute("data-agent-marker");
    await expect.poll(() => sidebarRow.getAttribute("data-agent-marker")).not.toBe(firstRunningMarker);
    await screenshotSidebar(page, testInfo, "codex-running-sidebar.png");

    await lifecycle(request, {
      sessionId, receipt: challenge.receipt, turnId, sequence: 3, state: "attention", attention: "input",
    });
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "waiting");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", "?");
    await expect(sidebarRow).toHaveAccessibleName(/codex waiting/);
    await screenshotSidebar(page, testInfo, "codex-waiting-sidebar.png");

    // The fixture waits for the real server publisher's 30-second stale clock.
    // It is not a native Codex observer acceptance run.
    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const snapshot = await response.json();
      return snapshot.agentEvents.find((event: { paneId: string }) => event.paneId === paneId)?.status;
    }, { timeout: 40_000 }).toBe("observer_stale");
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "stale", { timeout: 40_000 });
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", "!");
    await expect(sidebarRow).toHaveAccessibleName(/codex status unknown/);
    await screenshotSidebar(page, testInfo, "codex-stale-sidebar.png");

    await lifecycle(request, {
      sessionId, receipt: challenge.receipt, turnId, sequence: 4, state: "active", attention: null,
    });
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "running");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", runningMarker);

    await lifecycle(request, {
      sessionId, receipt: challenge.receipt, turnId, sequence: 5, state: "completed", attention: null,
    });
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "completed");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", "✓");
    await expect(sidebarRow).toHaveAccessibleName(/codex done/);
    await screenshotSidebar(page, testInfo, "codex-completed-sidebar.png");
  } finally {
    if (busyWorkspace) await request.delete(`/api/workspaces/${busyWorkspace.id}`).catch(() => undefined);
    if (workspace) await request.delete(`/api/workspaces/${workspace.id}`).catch(() => undefined);
  }
});
