import { expect, test, type Page } from "./fixtures";
import { e2eRegistrationToken } from "./config-auth.js";

interface FleetWorkspace {
  id: string;
  activeTabId: string;
  tabs: Array<{
    id: string;
    activePaneId: string;
  }>;
}

async function navigateToApp(page: Page): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto("/", { waitUntil: "commit", timeout: 10_000 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

test("shows three concurrent agents on two machines within one event revision", async ({
  page,
  request,
}, testInfo) => {
  const suffix = testInfo.project.name
    .replaceAll(/[^a-z0-9]+/gi, "-")
    .toLowerCase();
  const remoteMachineId = `fleet-remote-${suffix}`;
  const runIds = {
    approval: `fleet-approval-${suffix}`,
    local: `fleet-local-${suffix}`,
    remote: `fleet-remote-run-${suffix}`,
  };
  const createdWorkspaceIds: string[] = [];

  try {
    const registered = await request.post("/api/registry/hosts", {
      headers: { authorization: `Bearer ${e2eRegistrationToken()}` },
      data: {
        machine: {
          id: remoteMachineId,
          name: `Fleet Remote ${suffix}`,
          kind: "ssh",
          port: 1,
        },
        ttlMs: 60_000,
      },
    });
    expect(registered.ok()).toBeTruthy();

    const remoteResponse = await request.post("/api/workspaces", {
      data: { machineId: remoteMachineId },
    });
    expect(remoteResponse.ok()).toBeTruthy();
    const remoteWorkspace = (await remoteResponse.json() as {
      workspace: FleetWorkspace;
    }).workspace;
    createdWorkspaceIds.push(remoteWorkspace.id);

    const localResponse = await request.post("/api/workspaces", {
      data: { machineId: "local" },
    });
    expect(localResponse.ok()).toBeTruthy();
    const localWorkspace = (await localResponse.json() as {
      workspace: FleetWorkspace;
    }).workspace;
    createdWorkspaceIds.push(localWorkspace.id);

    const localTab = localWorkspace.tabs[0]!;
    const remoteTab = remoteWorkspace.tabs[0]!;
    const events = [
      {
        workspaceId: localWorkspace.id,
        tabId: localTab.id,
        paneId: localTab.activePaneId,
        runId: runIds.local,
        sessionId: `${runIds.local}-session`,
        agent: "codex",
        status: "running",
        title: "Implementing fleet controls",
        summary: "Updating client state",
        prompt: "Implement the fleet controls.",
      },
      {
        workspaceId: localWorkspace.id,
        tabId: localTab.id,
        paneId: localTab.activePaneId,
        runId: runIds.approval,
        sessionId: `${runIds.approval}-session`,
        agent: "claude",
        status: "waiting",
        attentionReason: "approval",
        title: "Reviewing rollout",
        summary: "Approval required for the rollout",
        message: "Approve the production rollout.",
        prompt: "Review the rollout.",
      },
      {
        workspaceId: remoteWorkspace.id,
        tabId: remoteTab.id,
        paneId: remoteTab.activePaneId,
        runId: runIds.remote,
        sessionId: `${runIds.remote}-session`,
        agent: "opencode",
        status: "running",
        title: "Checking the remote host",
        summary: "Running remote verification",
        prompt: "Verify the remote host.",
      },
    ];
    for (const event of events) {
      const response = await request.post("/api/agent-events", { data: event });
      expect(response.ok()).toBeTruthy();
    }

    await navigateToApp(page);
    await expect(page.locator("main.app-shell")).toBeVisible({
      timeout: 20_000,
    });
    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const search = palette.getByPlaceholder(
      "Search commands, workspaces, tabs, hosts",
    );
    await search.fill("Open agent fleet");
    await search.press("Enter");

    const fleet = page.getByRole("dialog", { name: "Agent fleet" });
    await expect(fleet).toBeVisible();
    const approvalRow = fleet.locator(
      `[data-agent-run-id="${runIds.approval}"]`,
    );
    const localRow = fleet.locator(
      `[data-agent-run-id="${runIds.local}"]`,
    );
    const remoteRow = fleet.locator(
      `[data-agent-run-id="${runIds.remote}"]`,
    );
    await expect(approvalRow).toHaveAttribute("data-agent-state", "waiting");
    await expect(approvalRow).toHaveAttribute("data-agent-machine", "local");
    await expect(approvalRow).toContainText("[APPROVAL]");
    await expect(localRow).toHaveAttribute("data-agent-state", "running");
    await expect(remoteRow).toHaveAttribute(
      "data-agent-machine",
      remoteMachineId,
    );
    await expect(remoteRow).toContainText("Running remote verification");

    const rowOrder = await fleet.locator(".agent-fleet-row").evaluateAll(
      (rows, ids) => rows
        .map((row) => row.getAttribute("data-agent-run-id"))
        .filter((id) => ids.includes(id ?? "")),
      Object.values(runIds),
    );
    expect(rowOrder[0]).toBe(runIds.approval);

    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const payload = await response.json() as { eventRevision: number };
      const rendered = Number(
        await fleet.getAttribute("data-event-revision"),
      );
      return {
        behindBy: payload.eventRevision - rendered,
        renderedAhead: rendered > payload.eventRevision,
      };
    }).toEqual({ behindBy: 0, renderedAhead: false });

    const bootstrapResponse = await request.get("/api/bootstrap");
    const bootstrap = await bootstrapResponse.json() as {
      notifications: Array<{ subtitle: string; body: string }>;
    };
    expect(bootstrap.notifications).toContainEqual(
      expect.objectContaining({
        subtitle: "approval required",
        body: "Approve the production rollout.",
      }),
    );
  } finally {
    for (const workspaceId of createdWorkspaceIds.reverse()) {
      await request.delete(`/api/workspaces/${workspaceId}`);
    }
    await request.delete(`/api/registry/hosts/${remoteMachineId}`);
  }
});
