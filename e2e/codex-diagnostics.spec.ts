import { awaitAppShell, expect, test, type E2eWorkspace } from "./fixtures";

test("renders unknown Codex binding diagnostics only after an explicit inspection refresh", async ({
  page,
  request,
  createReadyWorkspace,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop inspection coverage");
  let workspace: E2eWorkspace | undefined;
  try {
    workspace = await createReadyWorkspace();
    const tab = workspace.tabs[0]!;
    const paneId = tab.panes[0]!.id;
    const sessionId = `codex-diagnostics-${Date.now()}`;
    const issued = await request.post("/api/codex-bindings", { data: { sessionId } });
    expect(issued.ok()).toBeTruthy();
    const challenge = await issued.json() as { receipt: string; marker: string };
    const injected = await request.post(`/api/panes/${paneId}/input`, {
      data: { data: `${challenge.marker}\r`, cols: 100, rows: 32 },
    });
    expect(injected.ok()).toBeTruthy();
    await expect.poll(async () => (await request.post("/api/codex-bindings/resolve", {
      data: { sessionId, receipt: challenge.receipt },
    })).status()).toBe(200);
    const recorded = await request.post("/api/codex-bindings/observation", {
      data: {
        sessionId,
        receipt: challenge.receipt,
        channel: "naming",
        status: "unknown",
        reason: "socket_unavailable",
        sampledAt: Date.now() - 31_000,
        counters: { reconnects: 2 },
      },
    });
    expect(recorded.ok()).toBeTruthy();

    await page.goto(`/workspaces/${workspace.id}/tabs/${tab.id}`);
    await awaitAppShell(page);
    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByPlaceholder("Search commands, workspaces, tabs, hosts").fill("Open diagnostics");
    await palette.getByPlaceholder("Search commands, workspaces, tabs, hosts").press("Enter");
    const diagnostics = page.getByRole("dialog", { name: "wmux diagnostics" });
    await expect(diagnostics).toContainText("CODEX::BINDINGS");
    await expect(diagnostics).toContainText("SOCKET_UNAVAILABLE");
    await expect(diagnostics).toContainText(/sample \d+s ago/);
    await expect(diagnostics).toContainText("MISSING_TURN_ID");
    await expect(diagnostics).toContainText("socket recovery may resume sampling without sending a prompt");
    await expect(diagnostics).toContainText("CLI UNVERIFIED");

    await diagnostics.getByRole("button", { name: /REFRESH/ }).click();
    await expect(diagnostics).toContainText("CODEX::BINDINGS");

    const event = await request.post("/api/agent-events", {
      data: { paneId, agent: "codex", status: "running", summary: "diagnostic fixture" },
    });
    expect(event.ok()).toBeTruthy();
    await diagnostics.getByRole("button", { name: /CLOSE/ }).click();
    await page.keyboard.press("Control+K");
    await palette.getByPlaceholder("Search commands, workspaces, tabs, hosts").fill("Open agent fleet");
    await palette.getByPlaceholder("Search commands, workspaces, tabs, hosts").press("Enter");
    const fleet = page.getByRole("dialog", { name: "Agent fleet" });
    await expect(fleet.getByRole("region", { name: "Codex session inspector" })).toContainText("CODEX::SESSION_INSPECTOR");
    await expect(fleet.getByRole("combobox", { name: "Codex session to inspect" })).toBeEnabled();
    await fleet.getByRole("button", { name: /REFRESH INSPECTOR/ }).click();
    await expect(fleet.getByRole("region", { name: "Codex session inspector" })).toContainText("SOCKET_UNAVAILABLE");
  } finally {
    if (workspace) await request.delete(`/api/workspaces/${workspace.id}`).catch(() => undefined);
  }
});
