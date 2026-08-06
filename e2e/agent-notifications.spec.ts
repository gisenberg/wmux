import { expect, test } from "./fixtures";
import { e2eRegistrationToken } from "./config-auth.js";

interface NotificationWorkspace {
  id: string;
  tabs: Array<{
    id: string;
    activePaneId: string;
  }>;
}

test("a remote approval gate reaches a mobile browser within one heartbeat", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.startsWith("mobile-"),
    "mobile notification coverage",
  );
  const suffix = testInfo.project.name
    .replaceAll(/[^a-z0-9]+/gi, "-")
    .toLowerCase();
  const machineId = `notification-remote-${suffix}`;
  const workspaceIds: string[] = [];

  await page.addInitScript(() => {
    const notifications: Array<{
      title: string;
      body: string;
      tag: string;
      createdAt: number;
    }> = [];
    class CapturedNotification {
      static permission = "granted";

      constructor(title: string, options?: NotificationOptions) {
        notifications.push({
          title,
          body: options?.body ?? "",
          tag: options?.tag ?? "",
          createdAt: Date.now(),
        });
      }
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: CapturedNotification,
    });
    Object.defineProperty(window, "__wmuxCapturedNotifications", {
      configurable: true,
      value: notifications,
    });
  });

  try {
    const registration = await request.post("/api/registry/hosts", {
      headers: { authorization: `Bearer ${e2eRegistrationToken()}` },
      data: {
        machine: {
          id: machineId,
          name: `Notification Remote ${suffix}`,
          kind: "ssh",
          port: 1,
        },
        ttlMs: 60_000,
      },
    });
    expect(registration.ok()).toBeTruthy();
    const remoteResponse = await request.post("/api/workspaces", {
      data: { machineId },
    });
    expect(remoteResponse.ok()).toBeTruthy();
    const remoteWorkspace = (await remoteResponse.json() as {
      workspace: NotificationWorkspace;
    }).workspace;
    workspaceIds.push(remoteWorkspace.id);
    const localResponse = await request.post("/api/workspaces", {
      data: { machineId: "local" },
    });
    expect(localResponse.ok()).toBeTruthy();
    const localWorkspace = (await localResponse.json() as {
      workspace: NotificationWorkspace;
    }).workspace;
    workspaceIds.push(localWorkspace.id);

    await page.goto("/");
    const mobileChrome = page.getByRole(
      "banner",
      { name: "Mobile session controls" },
    );
    await expect(mobileChrome).toHaveAttribute(
      "data-service-connection",
      "online",
    );

    const remoteTab = remoteWorkspace.tabs[0]!;
    const startedAt = Date.now();
    const event = await request.post("/api/agent-events", {
      data: {
        workspaceId: remoteWorkspace.id,
        tabId: remoteTab.id,
        paneId: remoteTab.activePaneId,
        runId: `notification-run-${suffix}`,
        sessionId: `notification-session-${suffix}`,
        agent: "claude",
        status: "waiting",
        attentionReason: "approval",
        title: "Remote deployment",
        summary: "Approval required on the remote host",
        message: "Approve the remote deployment.",
        prompt: "Deploy the reviewed change.",
      },
    });
    expect(event.ok()).toBeTruthy();

    await expect.poll(() => page.evaluate(() => {
      const captured = (
        window as typeof window & {
          __wmuxCapturedNotifications?: Array<{
            title: string;
            body: string;
            tag: string;
            createdAt: number;
          }>;
        }
      ).__wmuxCapturedNotifications ?? [];
      return captured.at(-1);
    })).toEqual(expect.objectContaining({
      title: "claude: approval required",
      body: "Approve the remote deployment.",
      tag: expect.stringMatching(/^note_/),
    }));
    const deliveredAt = await page.evaluate(() => (
      window as typeof window & {
        __wmuxCapturedNotifications?: Array<{ createdAt: number }>;
      }
    ).__wmuxCapturedNotifications?.at(-1)?.createdAt ?? 0);
    expect(deliveredAt - startedAt).toBeLessThan(15_000);
  } finally {
    await page.close();
    for (const workspaceId of workspaceIds.reverse()) {
      await request.delete(`/api/workspaces/${workspaceId}`);
    }
    await request.delete(`/api/registry/hosts/${machineId}`);
  }
});
