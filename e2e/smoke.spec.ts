import { expect, test } from "./fixtures";

test("boots the application shell", async ({ page }) => {
  await expect(page.locator("main.app-shell")).toBeVisible();
});

test("loads an authenticated browser session", async ({ page, request }) => {
  const response = await request.get("/api/bootstrap");
  expect(response.ok()).toBeTruthy();
  await expect(page.locator(".login-view")).toHaveCount(0);
});

test("creates a ready workspace and removes it", async ({
  createReadyWorkspace,
  request,
}) => {
  const workspace = await createReadyWorkspace();
  const removed = await request.delete(`/api/workspaces/${workspace.id}`);
  expect(removed.ok()).toBeTruthy();
  await expect.poll(async () => {
    const response = await request.get("/api/bootstrap");
    const payload = await response.json() as {
      workspaces: Array<{ id: string }>;
    };
    return payload.workspaces.some((candidate) => candidate.id === workspace.id);
  }).toBe(false);
});
