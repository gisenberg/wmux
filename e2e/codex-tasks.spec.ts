import { awaitAppShell, expect, test } from "./fixtures";

// Browser fixture coverage only: native Codex endpoint and App Server behavior
// is covered by the server integration suite. These responses deliberately do
// not claim a live native task was opened.
test("catalog preserves identity, display associations, pagination, and disabled resume", async ({
  page,
  createReadyWorkspace,
}, testInfo) => {
  const calls: string[] = [];
  const launchBodies: Array<{ endpointIdentity?: string }> = [];
  const sampledAt = new Date().toISOString();
  const endpoint = {
    id: "e1",
    label: "Local",
    machineId: "local",
    identity:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    transport: "local",
    status: "available",
    reason: null,
    sampledAt,
    freshLaunch: true,
    launchReason: null,
  };
  const task = (threadId: string, name = "Same title") => ({
    endpointId: "e1",
    endpointIdentity: endpoint.identity,
    threadId,
    name,
    preview: "fixture preview",
    cwd: "/tmp/fixture",
    modelProvider: "codex",
    source: "fixture",
    parentThreadId: null,
    status: "idle",
    updatedAt: 1,
    sampledAt,
    stale: false,
    latestTurn: { id: "turn-1", status: "completed" },
  });
  // The association remains browser-visible even if future fixture bootstrap
  // state changes pin/favorite fields; it is a separate HTTP resource.
  await createReadyWorkspace();
  await page.route("**/api/codex-tasks/endpoints", (route) =>
    route.fulfill({ json: { endpoints: [endpoint] } }),
  );
  await page.route("**/api/codex-tasks/list", async (route) => {
    calls.push(`list:${route.request().postData()}`);
    const cursor = (
      JSON.parse(route.request().postData() || "{}") as { cursor?: string }
    ).cursor;
    await route.fulfill({
      json: {
        endpoint,
        tasks: cursor ? [task("thread-2")] : [task("thread-1")],
        nextCursor: cursor ? null : "next",
      },
    });
  });
  await page.route("**/api/codex-tasks/read", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}") as {
      threadId: string;
      history?: boolean;
    };
    calls.push(`read:${body.threadId}:${Boolean(body.history)}`);
    await route.fulfill({
      json: {
        task: task(body.threadId),
        turns: body.history
          ? [
              {
                id: "turn-1",
                status: "completed",
                text: "bounded fixture history",
                truncated: false,
              },
            ]
          : [],
        historyReason: body.history ? null : "History loads only on request",
        resume: { enabled: false, reason: "exact ownership not provable" },
      },
    });
  });
  let associations: unknown[] = [];
  await page.route("**/api/codex-task-associations", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { associations } });
    associations = [
      {
        id: "a1",
        ...(JSON.parse(route.request().postData() || "{}") as object),
        createdAt: "2026-01-01T00:00:00Z",
        resolved: true,
        reason: null,
      },
    ];
    return route.fulfill({ json: { association: associations[0] } });
  });
  await page.route("**/api/codex-task-launches", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { launches: [] } });
    }
    launchBodies.push(
      JSON.parse(route.request().postData() || "{}") as {
        endpointIdentity?: string;
      },
    );
    return route.fulfill({
      status: 503,
      json: { error: "fixture transport uncertain" },
    });
  });
  await page.reload();
  await awaitAppShell(page);
  const mobile = testInfo.project.name.startsWith("mobile-");
  if (mobile) {
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await page.getByRole("button", { name: "Actions", exact: true }).click();
  } else {
    await page.keyboard.press("Control+K");
  }
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette
    .getByPlaceholder("Search commands, workspaces, tabs, hosts")
    .fill("Open Codex tasks");
  if (mobile)
    await palette.getByRole("button", { name: /Open Codex tasks/ }).click();
  else
    await palette
      .getByPlaceholder("Search commands, workspaces, tabs, hosts")
      .press("Enter");
  const dialog = page.getByRole("dialog", { name: "Codex tasks" });
  await expect(dialog).toContainText("Same title");
  await expect(dialog).toContainText(`${endpoint.identity} · thread-1`);
  await dialog.screenshot({
    path: testInfo.outputPath("codex-tasks-catalog.png"),
  });
  const listCallsBeforeRefresh = calls.filter((call) =>
    call.startsWith("list:"),
  ).length;
  await dialog.getByRole("button", { name: "REFRESH" }).click();
  await expect
    .poll(() => calls.filter((call) => call.startsWith("list:")).length)
    .toBe(listCallsBeforeRefresh + 1);
  await expect(dialog).toContainText("Same title");
  await dialog
    .getByRole("button", { name: /Same title/ })
    .first()
    .click();
  await expect(dialog).toContainText(
    "Resume disabled: exact ownership not provable",
  );
  expect(calls).toContain("read:thread-1:false");
  expect(calls).not.toContain("read:thread-1:true");
  await dialog.getByRole("button", { name: "LOAD BOUNDED HISTORY" }).click();
  expect(calls).toContain("read:thread-1:true");
  const target = dialog.getByRole("combobox", { name: "Pane target" });
  await target.selectOption({ index: 1 });
  await dialog.getByRole("button", { name: "ASSOCIATE NEW" }).click();
  await expect(dialog).toContainText("Associated display target");
  await expect(dialog).toContainText("no title ownership or input authority");
  await dialog.getByRole("button", { name: "LOAD MORE" }).click();
  await expect(dialog).toContainText(`${endpoint.identity} · thread-2`);
  await dialog.getByRole("button", { name: "NEW CLI VIEW" }).click();
  expect(launchBodies).toEqual([expect.objectContaining({ endpointIdentity: endpoint.identity })]);
  await expect(dialog).toContainText("Launch outcome is uncertain");
  await expect(
    dialog.getByRole("button", { name: "NEW CLI VIEW" }),
  ).toBeDisabled();
});
