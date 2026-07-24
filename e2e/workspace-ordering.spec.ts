import { expect, test } from "./fixtures";

test("drags legacy workspace rows into a persisted order", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop drag-and-drop coverage");
  const firstResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  const secondResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(firstResponse.ok()).toBeTruthy();
  expect(secondResponse.ok()).toBeTruthy();
  const first = (await firstResponse.json() as { workspace: { id: string } }).workspace;
  const second = (await secondResponse.json() as { workspace: { id: string } }).workspace;

  try {
    await page.goto("/?legacy=1");
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    const source = page.locator(`a.workspace-item[href^="/workspaces/${second.id}/"]`);
    const target = page.locator(`a.workspace-item[href^="/workspaces/${first.id}/"]`);
    await expect(source).toBeVisible();
    await expect(target).toBeVisible();
    await source.dragTo(target, { targetPosition: { x: 30, y: 55 } });

    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const payload = await response.json() as { workspaces: Array<{ id: string }> };
      return payload.workspaces.map((workspace) => workspace.id).slice(0, 2);
    }).toEqual([first.id, second.id]);
  } finally {
    await request.delete(`/api/workspaces/${second.id}`);
    await request.delete(`/api/workspaces/${first.id}`);
  }
});

test("drags canvas workspace rows into a persisted order", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop canvas drag coverage");
  const firstResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  const secondResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(firstResponse.ok()).toBeTruthy();
  expect(secondResponse.ok()).toBeTruthy();
  const first = (await firstResponse.json() as { workspace: { id: string; name: string } }).workspace;
  const second = (await secondResponse.json() as { workspace: { id: string; name: string } }).workspace;

  try {
    await page.goto("/");
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    const canvas = page.locator(".open-tui-sidebar canvas");
    await expect(canvas).toBeVisible();
    const bounds = await canvas.evaluate((element: HTMLCanvasElement, names) => {
      const rect = element.getBoundingClientRect();
      const result: Record<string, { min: number; max: number }> = {};
      for (let y = 0; y < rect.height; y += 3) {
        element.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + 40,
          clientY: rect.top + y,
          pointerId: 99,
        }));
        for (const name of names) {
          if (!element.title.includes(name) || !element.title.includes("drag to reorder")) continue;
          const current = result[name];
          result[name] = current ? { min: Math.min(current.min, y), max: Math.max(current.max, y) } : { min: y, max: y };
        }
      }
      return result;
    }, [first.name, second.name]);
    expect(bounds[first.name]).toBeTruthy();
    expect(bounds[second.name]).toBeTruthy();
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    if (!box) throw new Error("canvas has no bounds");

    await page.mouse.move(box.x + 40, box.y + (bounds[second.name].min + bounds[second.name].max) / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + bounds[first.name].max, { steps: 12 });
    await page.mouse.up();

    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const payload = await response.json() as { workspaces: Array<{ id: string }> };
      return payload.workspaces.map((workspace) => workspace.id).slice(0, 2);
    }).toEqual([first.id, second.id]);
  } finally {
    await request.delete(`/api/workspaces/${second.id}`);
    await request.delete(`/api/workspaces/${first.id}`);
  }
});
