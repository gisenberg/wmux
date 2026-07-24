import {
  expect,
  test as base,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

export { expect };

export interface E2eWorkspace {
  id: string;
  name: string;
  activeTabId: string;
  parentWorkspaceId?: string;
  tabs: Array<{
    id?: string;
    panes: Array<{ id: string }>;
  }>;
}

interface BootstrapSignal {
  revision: number;
}

interface CreateWorkspaceOptions {
  machineId?: string;
  createdBy?: "user" | "agent";
  parentPaneId?: string;
}

interface WmuxFixtures {
  bootedServer: BootstrapSignal;
  authenticatedPage: Page;
  createReadyWorkspace: (options?: CreateWorkspaceOptions) => Promise<E2eWorkspace>;
  waitForTerminalOutput: (paneId: string, marker: string) => Promise<void>;
}

const readBootstrap = async (
  request: APIRequestContext,
): Promise<{ revision: number; workspaces: E2eWorkspace[] }> => {
  const response = await request.get("/api/bootstrap");
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ revision: number; workspaces: E2eWorkspace[] }>;
};

const waitForPaneMessage = async (
  page: Page,
  paneId: string,
  predicate: { kind: "ready" } | { kind: "output"; marker: string },
): Promise<void> => {
  await page.evaluate(
    ({ paneId: targetPaneId, predicate: targetPredicate }) =>
      new Promise<void>((resolve, reject) => {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(
          `${protocol}//${window.location.host}/ws/panes/${encodeURIComponent(targetPaneId)}/output?cols=100&rows=32`,
        );
        let output = "";
        const timeout = window.setTimeout(() => {
          socket.close();
          reject(new Error(`Timed out waiting for pane ${targetPaneId} ${targetPredicate.kind}`));
        }, 20_000);
        const finish = () => {
          window.clearTimeout(timeout);
          socket.close();
          resolve();
        };
        socket.addEventListener("error", () => {
          window.clearTimeout(timeout);
          reject(new Error(`Pane ${targetPaneId} output socket failed`));
        });
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const message = JSON.parse(event.data) as {
            type?: string;
            replay?: string;
            data?: string;
          };
          if (message.type === "ready") {
            output += message.replay ?? "";
            if (targetPredicate.kind === "ready") {
              finish();
              return;
            }
          }
          if (message.type === "output") output += message.data ?? "";
          if (targetPredicate.kind === "output" && output.includes(targetPredicate.marker)) finish();
        });
      }),
    { paneId, predicate },
  );
};

export const test = base.extend<WmuxFixtures>({
  bootedServer: async ({ request }, use) => {
    const bootstrap = await readBootstrap(request);
    await use({ revision: bootstrap.revision });
  },
  authenticatedPage: async ({ page, bootedServer }, use) => {
    void bootedServer;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      Math.random = () => 0;
    });
    await page.goto("/");
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    await use(page);
  },
  waitForTerminalOutput: async ({ authenticatedPage }, use) => {
    await use((paneId, marker) =>
      waitForPaneMessage(authenticatedPage, paneId, { kind: "output", marker }));
  },
  createReadyWorkspace: async ({ authenticatedPage, request }, use) => {
    await use(async (options = {}) => {
      const before = await readBootstrap(request);
      const response = await request.post("/api/workspaces", {
        data: { machineId: "local", ...options },
      });
      expect(response.ok()).toBeTruthy();
      const workspace = (await response.json() as { workspace: E2eWorkspace }).workspace;
      await expect.poll(async () => {
        const bootstrap = await readBootstrap(request);
        return bootstrap.revision > before.revision &&
          bootstrap.workspaces.some((candidate) => candidate.id === workspace.id);
      }).toBe(true);
      await waitForPaneMessage(
        authenticatedPage,
        workspace.tabs[0]!.panes[0]!.id,
        { kind: "ready" },
      );
      return workspace;
    });
  },
});

test.beforeEach(async ({ authenticatedPage }) => {
  void authenticatedPage;
});

export const routeTerminalFontFamily = async (
  page: Page,
  terminalFontFamily: string,
): Promise<void> => {
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, terminalFontFamily } });
  });
  await page.routeWebSocket("**/ws/events", (webSocket) => {
    const server = webSocket.connectToServer();
    server.onMessage((message) => {
      if (typeof message !== "string") {
        webSocket.send(message);
        return;
      }
      try {
        const payload = JSON.parse(message) as {
          type?: string;
          state?: Record<string, unknown>;
        };
        if (payload.type === "snapshot" && payload.state) {
          webSocket.send(JSON.stringify({
            ...payload,
            state: { ...payload.state, terminalFontFamily },
          }));
          return;
        }
      } catch {
        // Forward non-JSON event messages unchanged.
      }
      webSocket.send(message);
    });
  });
};

export const createNestedWorkspacePair = async (
  request: APIRequestContext,
): Promise<{ root: E2eWorkspace; child: E2eWorkspace }> => {
  const rootResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(rootResponse.ok()).toBeTruthy();
  const root = (await rootResponse.json() as { workspace: E2eWorkspace }).workspace;
  const childResponse = await request.post("/api/workspaces", {
    data: {
      machineId: "local",
      createdBy: "agent",
      parentPaneId: root.tabs[0]!.panes[0]!.id,
    },
  });
  expect(childResponse.ok()).toBeTruthy();
  const child = (await childResponse.json() as { workspace: E2eWorkspace }).workspace;
  return { child, root };
};
