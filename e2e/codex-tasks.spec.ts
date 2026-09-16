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
  const longUnicodeName = "Same title — 日本語 Ελληνικά e\u0301 👩🏽‍💻 🚀 ".repeat(12);
  const task = (threadId: string, name = longUnicodeName) => ({
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
  const workspace = await createReadyWorkspace();
  const knownTarget = {
    workspaceId: workspace.id,
    tabId: workspace.activeTabId,
    paneId: workspace.tabs[0]!.panes[0]!.id,
  };
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
    const input = JSON.parse(route.request().postData() || "{}") as {
      target?: object;
    };
    expect(Object.keys(input.target ?? {}).sort()).toEqual([
      "paneId",
      "tabId",
      "workspaceId",
    ]);
    associations = [
      {
        id: "a1",
        ...input,
        createdAt: "2026-01-01T00:00:00Z",
        resolved: true,
        reason: null,
      },
    ];
    return route.fulfill({ json: { association: associations[0] } });
  });
  let missingServerAttempt = false;
  let recordedLaunch: Record<string, unknown> | null = null;
  await page.route("**/api/codex-task-launches**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (
      pathname === "/api/codex-task-launches" &&
      route.request().method() === "GET"
    ) {
      return route.fulfill({ json: { launches: recordedLaunch ? [recordedLaunch] : [] } });
    }
    if (pathname !== "/api/codex-task-launches") {
      if (missingServerAttempt) return route.fulfill({ status: 404, json: { error: "launch_not_found" } });
      const acknowledged = pathname.endsWith("/acknowledge");
      const launch = {
        requestId: pathname.split("/")[3], endpointId: endpoint.id,
        status: "unknown", target: knownTarget,
        reason: "fixture outcome remains unknown", createdAt: new Date().toISOString(),
        ...(acknowledged ? { acknowledgedAt: new Date().toISOString() } : {}),
      };
      recordedLaunch = launch;
      return route.fulfill({ json: { launch } });
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
  const openCatalog = async () => {
    if (mobile) {
      const chat = page.getByRole("button", { name: "Open chat", exact: true });
      if (await chat.isVisible()) await chat.click();
      await page.getByRole("button", { name: "Actions", exact: true }).click();
    } else await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const search = palette.getByPlaceholder("Search commands, workspaces, tabs, hosts");
    await search.fill("Open Codex tasks");
    if (mobile) await palette.getByRole("button", { name: /Open Codex tasks/ }).click();
    else await search.press("Enter");
  };
  await openCatalog();
  const dialog = page.getByRole("dialog", { name: "Codex tasks" });
  const assertNoHorizontalOverflow = async (phase: string) => {
    await dialog.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const horizontalBounds = await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowing: Array.from(element.querySelectorAll<HTMLElement>("*")).flatMap((child) => {
          const childBounds = child.getBoundingClientRect();
          return childBounds.right > bounds.right + 1 || child.scrollWidth > child.clientWidth + 1
            ? [{ tag: child.tagName, className: child.className, right: Math.round(childBounds.right), containerRight: Math.round(bounds.right), clientWidth: child.clientWidth, scrollWidth: child.scrollWidth }]
            : [];
        }),
      };
    });
    expect(
      horizontalBounds.scrollWidth,
      `horizontal overflow (${phase}): ${JSON.stringify(horizontalBounds)}`,
    ).toBeLessThanOrEqual(horizontalBounds.clientWidth + 1);
  };
  await expect(dialog).toContainText("Same title");
  await expect(dialog).toContainText(`${endpoint.identity} · thread-1`);
  await expect(dialog.locator(".codex-task-list strong").first()).toHaveText(longUnicodeName.trim());
  await assertNoHorizontalOverflow("catalog list");
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
  await assertNoHorizontalOverflow("task detail and association controls");
  await dialog.getByRole("button", { name: "LOAD MORE" }).click();
  await expect(dialog).toContainText(`${endpoint.identity} · thread-2`);
  await dialog.getByRole("button", { name: "NEW CLI VIEW" }).click();
  expect(launchBodies).toEqual([
    expect.objectContaining({ endpointIdentity: endpoint.identity }),
  ]);
  await expect(dialog).toContainText("Launch outcome is uncertain");
  await expect(
    dialog.getByRole("button", { name: "NEW CLI VIEW" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "RECONCILE" }).click();
  await expect(
    dialog.getByRole("button", { name: "OPEN TARGET" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: /I INSPECTED THIS ATTEMPT/ })
    .click();
  await expect(
    dialog.getByRole("button", { name: "NEW CLI VIEW" }),
  ).toBeEnabled();
  expect(launchBodies).toHaveLength(1);
  missingServerAttempt = true;
  await dialog.getByRole("button", { name: "NEW CLI VIEW" }).click();
  await expect(dialog.getByRole("button", { name: "NEW CLI VIEW" })).toBeDisabled();
  await dialog.getByRole("button", { name: /I INSPECTED THIS ATTEMPT/ }).click();
  await expect(dialog).toContainText("No recorded server attempt was found");
  await expect(dialog.getByRole("button", { name: "NEW CLI VIEW" })).toBeEnabled();
  expect(launchBodies).toHaveLength(2);
  await page.reload();
  await awaitAppShell(page);
  await openCatalog();
  await expect(dialog).toContainText("Same title");
  await dialog.getByLabel("Absolute working directory").fill("/tmp/fixture");
  await expect(dialog.getByRole("button", { name: "NEW CLI VIEW" })).toBeEnabled();
  expect(launchBodies).toHaveLength(2);
});
