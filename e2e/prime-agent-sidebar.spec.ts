import { awaitAppShell, expect, test } from "./fixtures";

interface SidebarWorkspace {
  id: string;
  activeTabId: string;
  tabs: Array<{ id: string; activePaneId: string }>;
}

test("Prime heartbeat scheduling pulses only while the agent is idle", async ({
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

    const scheduled = await request.post("/api/agent-events", {
      data: {
        workspaceId: workspace.id,
        tabId: tab.id,
        paneId: tab.activePaneId,
        agent: "prime-agent",
        heartbeatActive: true,
      },
    });
    expect(scheduled.ok()).toBeTruthy();
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "running");

    const setupCompleted = await request.post("/api/agent-events", {
      data: {
        ...eventTarget,
        status: "completed",
        summary: "Heartbeat scheduled",
      },
    });
    expect(setupCompleted.ok()).toBeTruthy();
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "heartbeat");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", /[·♡♥]/);
    await expect(sidebarRow).toHaveAccessibleName(/prime-agent heartbeat/);

    const delivered = await request.post("/api/agent-events", {
      data: {
        ...eventTarget,
        runId: `${eventTarget.runId}-delivery`,
        status: "running",
        summary: "Prime Agent is working",
      },
    });
    expect(delivered.ok()).toBeTruthy();
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "running");
    await expect(sidebarRow).toHaveAttribute("data-agent-marker", /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

    const deliveryCompleted = await request.post("/api/agent-events", {
      data: {
        ...eventTarget,
        runId: `${eventTarget.runId}-delivery`,
        status: "completed",
        summary: "Heartbeat work completed",
      },
    });
    expect(deliveryCompleted.ok()).toBeTruthy();
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "heartbeat");

    const cleared = await request.post("/api/agent-events", {
      data: {
        workspaceId: workspace.id,
        tabId: tab.id,
        paneId: tab.activePaneId,
        agent: "prime-agent",
        heartbeatActive: false,
      },
    });
    expect(cleared.ok()).toBeTruthy();
    await expect(sidebarRow).toHaveAttribute("data-agent-status", "completed");
    await expect(sidebarRow).toHaveAccessibleName(/prime-agent done/);
  } finally {
    if (workspaceId) {
      await request.delete(`/api/workspaces/${workspaceId}`).catch(() => undefined);
    }
  }
});
