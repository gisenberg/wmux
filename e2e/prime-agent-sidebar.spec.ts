import { awaitAppShell, expect, test } from "./fixtures";

interface SidebarWorkspace {
  id: string;
  activeTabId: string;
  tabs: Array<{ id: string; activePaneId: string }>;
}

test("Prime Agent sidebar indicator transitions from working to awaiting input", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop canvas sidebar coverage");
  let workspaceId: string | undefined;

  try {
    const created = await request.post("/api/workspaces", {
      data: { machineId: "local" },
    });
    expect(created.ok()).toBeTruthy();
    const workspace = (await created.json() as { workspace: SidebarWorkspace }).workspace;
    workspaceId = workspace.id;
    const tab = workspace.tabs[0]!;
    const eventTarget = {
      workspaceId: workspace.id,
      tabId: tab.id,
      paneId: tab.activePaneId,
      runId: `prime-sidebar-${workspace.id}`,
      sessionId: `prime-sidebar-session-${workspace.id}`,
      agent: "prime-agent",
      title: "Prime sidebar status",
    };

    const active = await request.post("/api/agent-events", {
      data: {
        ...eventTarget,
        status: "running",
        summary: "Prime Agent is working",
      },
    });
    expect(active.ok()).toBeTruthy();

    await page.goto(`/workspaces/${workspace.id}/tabs/${tab.id}`);
    await awaitAppShell(page);
    const sidebarRow = page.locator(
      `a[role="treeitem"][href^="/workspaces/${workspace.id}/"]`,
    );
    await expect(sidebarRow).toHaveAttribute("data-agent-name", "prime-agent");
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "running");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    await expect(sidebarRow).toHaveAccessibleName(/prime-agent working/);

    const waiting = await request.post("/api/agent-events", {
      data: {
        ...eventTarget,
        status: "waiting",
        attentionReason: "input",
        summary: "Prime Agent is waiting for input",
      },
    });
    expect(waiting.ok()).toBeTruthy();

    await expect(sidebarRow).toHaveAttribute("data-agent-status", "waiting");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", "?");
    await expect(sidebarRow).toHaveAccessibleName(/prime-agent waiting/);
  } finally {
    if (workspaceId) {
      await request.delete(`/api/workspaces/${workspaceId}`).catch(() => undefined);
    }
  }
});
