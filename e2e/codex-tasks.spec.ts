import {
  awaitAppShell,
  expect,
  test as baseTest,
  type E2eWorkspace,
} from "./fixtures";

const test = baseTest.extend<{
  createCatalogWorkspace: () => Promise<E2eWorkspace>;
}>({
  createCatalogWorkspace: async ({ createReadyWorkspace, request }, use) => {
    const ids: string[] = [];
    try {
      await use(async () => {
        const workspace = await createReadyWorkspace();
        ids.push(workspace.id);
        return workspace;
      });
    } finally {
      await Promise.all(ids.map(async (id) => {
        const response = await request.delete(`/api/workspaces/${id}`);
        expect(response.ok()).toBeTruthy();
      }));
    }
  },
});

// Browser fixture coverage only: native Codex endpoint and App Server behavior
// is covered by the server integration suite. These responses deliberately do
// not claim a live native task was opened.
test("catalog preserves identity, display associations, pagination, and disabled resume", async ({
  page,
  request,
  createCatalogWorkspace,
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
  const workspace = await createCatalogWorkspace();
  const longTargetName = "選択先 👩🏽‍💻 e\u0301 ".repeat(8);
  expect((await request.post(`/api/workspaces/${workspace.id}/title`, {
    data: { title: longTargetName },
  })).ok()).toBeTruthy();
  expect((await request.post(`/api/workspaces/${workspace.id}/tabs/${workspace.activeTabId}/title`, {
    data: { title: longTargetName },
  })).ok()).toBeTruthy();
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
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
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
  await expect(dialog.locator(".codex-endpoint-identity")).toHaveText(endpoint.identity);
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
    "Open unavailable: exact ownership not provable",
  );
  expect(calls).toContain("read:thread-1:false");
  expect(calls).not.toContain("read:thread-1:true");
  await dialog.getByRole("button", { name: "LOAD BOUNDED HISTORY" }).click();
  expect(calls).toContain("read:thread-1:true");
  const target = dialog.getByRole("combobox", { name: "Pane target" });
  await target.selectOption({ index: 1 });
  await expect(target.locator("option").nth(1)).toContainText("選択先");
  await expect(target.locator("option").nth(1)).not.toContainText(longTargetName.trim());
  await expect(dialog.locator(".codex-target-identity")).toContainText(knownTarget.paneId);
  await dialog.getByRole("button", { name: "ASSOCIATE NEW" }).click();
  await expect(dialog).toContainText("Associated activity target");
  await expect(dialog).toContainText("do not establish a terminal binding");
  await assertNoHorizontalOverflow("task detail and association controls");
  await dialog.getByRole("button", { name: "LOAD MORE" }).click();
  await expect(dialog).toContainText(`${endpoint.identity} · thread-2`);
  await dialog.getByRole("button", { name: "START NEW TASK" }).click();
  expect(launchBodies).toEqual([
    expect.objectContaining({ endpointIdentity: endpoint.identity }),
  ]);
  await expect(dialog).toContainText("Launch outcome is uncertain");
  await expect(
    dialog.getByRole("button", { name: "START NEW TASK" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "RECONCILE" }).click();
  await expect(
    dialog.getByRole("button", { name: "OPEN TARGET" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: /I INSPECTED THIS ATTEMPT/ })
    .click();
  await expect(
    dialog.getByRole("button", { name: "START NEW TASK" }),
  ).toBeEnabled();
  expect(launchBodies).toHaveLength(1);
  missingServerAttempt = true;
  await dialog.getByRole("button", { name: "START NEW TASK" }).click();
  await expect(dialog.getByRole("button", { name: "START NEW TASK" })).toBeDisabled();
  await dialog.getByRole("button", { name: /I INSPECTED THIS ATTEMPT/ }).click();
  await expect(dialog).toContainText("No recorded server attempt was found");
  await expect(dialog.getByRole("button", { name: "START NEW TASK" })).toBeEnabled();
  expect(launchBodies).toHaveLength(2);
  await page.reload();
  await awaitAppShell(page);
  await openCatalog();
  await expect(dialog).toContainText("Same title");
  await dialog.getByLabel("Absolute working directory").fill("/tmp/fixture");
  await expect(dialog.getByRole("button", { name: "START NEW TASK" })).toBeEnabled();
  expect(launchBodies).toHaveLength(2);
});

test("existing-task open revalidates its attestation, retries the same request, and keeps associations separate", async ({
  page,
  createCatalogWorkspace,
}, testInfo) => {
  const sampledAt = new Date().toISOString();
  const endpoint = {
    id: "e1", label: "Local", machineId: "local",
    identity: "f".repeat(64), transport: "local", status: "available",
    reason: null, sampledAt, freshLaunch: true, launchReason: null,
  };
  const task = {
    endpointId: endpoint.id, endpointIdentity: endpoint.identity,
    threadId: "123e4567-e89b-42d3-a456-426614174000", name: "Shared task",
    preview: "active task", cwd: "/tmp/task", modelProvider: "codex",
    source: "fixture", parentThreadId: null, status: "active", updatedAt: 1,
    sampledAt, stale: false, latestTurn: null,
  };
  const workspace = await createCatalogWorkspace();
  const associationTarget = {
    workspaceId: workspace.id, tabId: workspace.activeTabId,
    paneId: workspace.tabs[0]!.panes[0]!.id,
  };
  const openedTarget = {
    workspaceId: workspace.id, tabId: workspace.activeTabId,
    paneId: "verified-new-pane",
  };
  const attachBodies: Array<Record<string, unknown>> = [];
  let firstAttach = true;
  let stale = false;
  await page.route("**/api/codex-tasks/endpoints", route => route.fulfill({ json: { endpoints: [endpoint] } }));
  await page.route("**/api/codex-tasks/list", route => route.fulfill({ json: { endpoint, tasks: [{ ...task, stale }], nextCursor: null } }));
  await page.route("**/api/codex-tasks/read", route => route.fulfill({ json: {
    task: { ...task, stale }, turns: [], historyReason: "History loads only on request",
    resume: stale
      ? { enabled: false, reason: "attestation expired after refresh" }
      : { enabled: true, reason: "eligible", generation: "opaque-attestation", target: null },
  } }));
  await page.route("**/api/codex-task-associations", route => route.fulfill({ json: { associations: [{
    id: "association-1", endpointId: endpoint.id, endpointIdentity: endpoint.identity,
    threadId: task.threadId, target: associationTarget, createdAt: sampledAt,
    resolved: true, reason: null,
  }] } }));
  await page.route("**/api/codex-task-launches**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && pathname === "/api/codex-task-launches")
      return route.fulfill({ json: { launches: [] } });
    if (route.request().method() === "GET") return route.fulfill({ json: { launch: {
      requestId: pathname.split("/")[3], endpointId: endpoint.id,
      endpointIdentity: endpoint.identity, operation: "attach", threadId: task.threadId,
      generation: "opaque-attestation", status: "unknown", target: openedTarget,
      reason: "terminal_identity_unverified", createdAt: sampledAt,
    } } });
    if (pathname.endsWith("/acknowledge")) return route.fulfill({ json: { launch: {
      requestId: pathname.split("/")[3], endpointId: endpoint.id,
      endpointIdentity: endpoint.identity, operation: "attach", threadId: task.threadId,
      generation: "opaque-attestation", status: "unknown", target: openedTarget,
      reason: "terminal_identity_unverified", createdAt: sampledAt,
      acknowledgedAt: new Date().toISOString(),
    } } });
    const body = JSON.parse(route.request().postData() || "{}") as Record<string, unknown>;
    attachBodies.push(body);
    if (firstAttach) {
      firstAttach = false;
      return route.fulfill({ status: 503, json: { error: "lost response" } });
    }
    return route.fulfill({ json: { launch: {
      requestId: body.requestId, endpointId: endpoint.id, endpointIdentity: endpoint.identity,
      operation: "attach", threadId: task.threadId, generation: "opaque-attestation",
      status: "opened", target: openedTarget, reason: null, createdAt: sampledAt,
    } } });
  });
  await page.reload();
  await awaitAppShell(page);
  if (testInfo.project.name.startsWith("mobile-")) {
    const chat = page.getByRole("button", { name: "Open chat", exact: true });
    if (await chat.isVisible()) await chat.click();
    await page.getByRole("button", { name: "Actions", exact: true }).click();
  } else await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const search = palette.getByPlaceholder("Search commands, workspaces, tabs, hosts");
  await search.fill("Open Codex tasks");
  if (testInfo.project.name.startsWith("mobile-")) await palette.getByRole("button", { name: /Open Codex tasks/ }).click();
  else await search.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Codex tasks" });
  await dialog.getByRole("button", { name: "Shared task" }).click();
  await expect(dialog.getByRole("button", { name: "OPEN IN CLI" })).toBeVisible();
  await expect(dialog).toContainText("Active tasks share the original task");
  await expect(dialog).toContainText("Associated activity target");
  await dialog.getByRole("button", { name: "OPEN IN CLI" }).click();
  await expect(dialog.getByRole("button", { name: "RETRY SAME OPEN REQUEST" })).toBeVisible();
  await dialog.getByRole("button", { name: "RETRY SAME OPEN REQUEST" }).click();
  await expect.poll(() => attachBodies.length).toBe(2);
  expect(attachBodies[0]).toEqual(expect.objectContaining({
    operation: "attach", endpointId: endpoint.id, endpointIdentity: endpoint.identity,
    threadId: task.threadId, generation: "opaque-attestation",
  }));
  expect(attachBodies[1]).toEqual(attachBodies[0]);
  await expect(dialog.getByRole("button", { name: "OPEN TARGET" })).toBeHidden();
  await dialog.getByRole("button", { name: "INSPECT ATTACHMENT" }).click();
  await expect(dialog).toContainText("terminal_identity_unverified");
  await expect(dialog.getByRole("button", { name: "OPEN TARGET" })).toBeHidden();
  await dialog.getByRole("button", { name: /I INSPECTED THIS ATTACHMENT/ }).click();
  await expect(dialog.getByRole("button", { name: "OPEN IN CLI" })).toBeEnabled();
  await dialog.getByRole("button", { name: "OPEN IN CLI" }).click();
  await expect.poll(() => attachBodies.length).toBe(3);
  expect(attachBodies[2]!.requestId).not.toBe(attachBodies[0]!.requestId);
  stale = true;
  await dialog.getByRole("button", { name: "REFRESH" }).click();
  await dialog.getByRole("button", { name: "Shared task" }).click();
  await expect(dialog).toContainText("Open unavailable: attestation expired after refresh");
});
