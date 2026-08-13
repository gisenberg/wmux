import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

interface FollowUpWorkspace {
  id: string;
  activeTabId: string;
  tabs: Array<{
    id: string;
    activePaneId: string;
  }>;
}

test("delegate, review, and revise without attaching a terminal", async ({
  page,
  request,
}, testInfo) => {
  const projectSuffix = testInfo.project.name
    .replaceAll(/[^a-z0-9]+/gi, "-")
    .toLowerCase();
  const suffix = [
    projectSuffix,
    testInfo.repeatEachIndex > 0 ? `repeat-${testInfo.repeatEachIndex}` : "",
    testInfo.retry > 0 ? `retry-${testInfo.retry}` : "",
  ].filter(Boolean).join("-");
  const marker = path.resolve(
    "test-results",
    "agent-follow-up-revision.txt",
  );
  const sessionId = `follow-up-session-${suffix}`;
  let workspaceId = "";
  fs.rmSync(marker, { force: true });

  try {
    const workspaceResponse = await request.post("/api/workspaces", {
      data: { machineId: "local" },
    });
    expect(workspaceResponse.ok()).toBeTruthy();
    const workspace = (await workspaceResponse.json() as {
      workspace: FollowUpWorkspace;
    }).workspace;
    workspaceId = workspace.id;
    const tab = workspace.tabs[0]!;

    const delegated = await request.post("/api/agent-events", {
      data: {
        workspaceId: workspace.id,
        tabId: tab.id,
        paneId: tab.activePaneId,
        runId: `follow-up-initial-${suffix}`,
        sessionId,
        agent: "codex",
        status: "completed",
        title: "Initial implementation",
        prompt: "Implement the initial change.",
        message: "Initial implementation complete.",
      },
    });
    expect(delegated.ok()).toBeTruthy();

    if (testInfo.project.name.startsWith("mobile-")) {
      await page.goto(
        `/workspaces/${workspace.id}/tabs/${tab.id}`,
      );
      await expect(
        page.getByRole("button", { name: "Review changes" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Review changes" }).click();
      await expect(
        page.getByText(
          "Review complete. The working-tree snapshot is ready for revision.",
          { exact: true },
        ).last(),
      ).toBeVisible();
      expect(fs.existsSync(marker)).toBe(false);

      await page.getByLabel("Write access").check();
      await page.getByLabel("Unattended").check();
      await page.getByRole("textbox", { name: "Agent message" }).fill(
        "Create the reviewed revision marker.",
      );
      await page.getByRole("button", { name: "Send message" }).click();
      await expect.poll(() => fs.existsSync(marker)).toBe(true);
    } else {
      const reviewed = await request.post(
        `/api/agent-sessions/${sessionId}/turns`,
        { data: { action: "review" } },
      );
      expect(reviewed.ok()).toBeTruthy();
      const reviewResult = await reviewed.json() as {
        delegation: { state: string; result: string };
        snapshot?: { url: string };
      };
      expect(reviewResult.delegation).toEqual(expect.objectContaining({
        state: "completed",
        result: expect.stringContaining("Review complete"),
      }));
      expect(reviewResult.snapshot?.url).toMatch(
        /^\/api\/repository-snapshots\//,
      );
      expect(fs.existsSync(marker)).toBe(false);

      const revised = await request.post(
        `/api/agent-sessions/${sessionId}/turns`,
        {
          data: {
            action: "continue",
            prompt: "Create the reviewed revision marker.",
            writeAccess: true,
            unattended: true,
          },
        },
      );
      expect(revised.ok()).toBeTruthy();
      const revisionResult = await revised.json() as {
        delegation: { state: string; result: string };
      };
      expect(revisionResult.delegation).toEqual(expect.objectContaining({
        state: "completed",
        result: "Revision marker created.",
      }));
    }

    expect(fs.readFileSync(marker, "utf8")).toBe("reviewed revision\n");
    await expect.poll(async () => {
      const timelineResponse = await request.get(
        `/api/agent-sessions/${sessionId}`,
      );
      expect(timelineResponse.ok()).toBeTruthy();
      const { timeline } = await timelineResponse.json() as {
        timeline: {
          entries: Array<{
            kind: string;
            state?: string;
            snapshot?: { url: string };
          }>;
        };
      };
      return {
        outcomeCount: timeline.entries.filter((entry) => entry.kind === "outcome").length,
        snapshotUrl: timeline.entries.find((entry) => entry.kind === "snapshot")?.snapshot?.url,
      };
    }, { timeout: 10_000 }).toEqual({
      outcomeCount: 3,
      snapshotUrl: expect.stringMatching(/^\/api\/repository-snapshots\//),
    });
  } finally {
    fs.rmSync(marker, { force: true });
    if (workspaceId) {
      await request.delete(`/api/workspaces/${workspaceId}`);
    }
  }
});
