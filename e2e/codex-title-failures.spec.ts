import { expect, test, type APIRequestContext, type E2eWorkspace } from "./fixtures";

interface CodexChallenge {
  receipt: string;
  marker: string;
}

interface TitleState {
  workspaces: Array<{
    id: string;
    name: string;
    nameSource: string;
    tabs: Array<{ id: string; title: string; titleSource: string }>;
  }>;
}

// This is an isolated browser fixture using real wmux HTTP and PTY marker
// routes. It does not launch Codex, connect an App Server socket, or claim to
// exercise native metadata transport. The explicit title posts model delivery
// order at the helper boundary.
const bindFixturePane = async (
  request: APIRequestContext,
  workspace: E2eWorkspace,
  sessionId: string,
): Promise<CodexChallenge> => {
  const issued = await request.post("/api/codex-bindings", { data: { sessionId } });
  expect(issued.ok()).toBeTruthy();
  const challenge = await issued.json() as CodexChallenge;
  const paneId = workspace.tabs[0]!.panes[0]!.id;
  const marker = await request.post(`/api/panes/${paneId}/input`, {
    data: { data: `${challenge.marker}\r`, cols: 100, rows: 32 },
  });
  expect(marker.ok()).toBeTruthy();
  await expect.poll(async () =>
    (await request.post("/api/codex-bindings/resolve", {
      data: { sessionId, receipt: challenge.receipt },
    })).status(),
  ).toBe(200);
  return challenge;
};

const postTitle = async (
  request: APIRequestContext,
  input: { sessionId: string; receipt: string; title: string },
): Promise<void> => {
  const response = await request.post("/api/codex-bindings/title", {
    data: { ...input, mode: "auto" },
  });
  expect(response.ok()).toBeTruthy();
};

const snapshot = async (request: APIRequestContext): Promise<TitleState> => {
  const response = await request.get("/api/bootstrap");
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<TitleState>;
};

test("M1-03 keeps manual repins when a delayed Codex title delivery arrives", async ({
  request,
  createReadyWorkspace,
}) => {
  const suffix = `title-race-${Date.now()}`;
  let target: E2eWorkspace | undefined;
  let other: E2eWorkspace | undefined;
  try {
    target = await createReadyWorkspace();
    other = await createReadyWorkspace();
    const targetTab = target.tabs[0]!.id!;
    const otherTab = other.tabs[0]!.id!;
    const sessionId = `${suffix}-session`;
    const challenge = await bindFixturePane(request, target, sessionId);

    expect((await request.post(`/api/workspaces/${other.id}/title`, {
      data: { title: "Other workspace pin" },
    })).ok()).toBeTruthy();
    expect((await request.post(`/api/workspaces/${other.id}/tabs/${otherTab}/title`, {
      data: { title: "Other tab pin" },
    })).ok()).toBeTruthy();

    expect((await request.post(`/api/workspaces/${target.id}/title`, {
      data: { title: "Manual workspace repin" },
    })).ok()).toBeTruthy();
    expect((await request.post(`/api/workspaces/${target.id}/tabs/${targetTab}/title`, {
      data: { title: "Manual tab repin" },
    })).ok()).toBeTruthy();

    await postTitle(request, {
      sessionId,
      receipt: challenge.receipt,
      title: "Delayed in-flight native sample",
    });

    const state = await snapshot(request);
    const current = state.workspaces.find((workspace) => workspace.id === target!.id)!;
    const untouched = state.workspaces.find((workspace) => workspace.id === other!.id)!;
    expect(current).toMatchObject({ name: "Manual workspace repin", nameSource: "user" });
    expect(current.tabs.find((tab) => tab.id === targetTab)).toMatchObject({
      title: "Manual tab repin", titleSource: "user",
    });
    expect(untouched).toMatchObject({ name: "Other workspace pin", nameSource: "user" });
    expect(untouched.tabs.find((tab) => tab.id === otherTab)).toMatchObject({
      title: "Other tab pin", titleSource: "user",
    });
  } finally {
    if (target) await request.delete(`/api/workspaces/${target.id}`).catch(() => undefined);
    if (other) await request.delete(`/api/workspaces/${other.id}`).catch(() => undefined);
  }
});

test("M1-05 restores only fresh metadata after an isolated title-delivery outage", async ({
  request,
  createReadyWorkspace,
}) => {
  const suffix = `title-outage-${Date.now()}`;
  let target: E2eWorkspace | undefined;
  let other: E2eWorkspace | undefined;
  try {
    target = await createReadyWorkspace();
    other = await createReadyWorkspace();
    const targetTab = target.tabs[0]!.id!;
    const otherTab = other.tabs[0]!.id!;
    const sessionId = `${suffix}-session`;
    const challenge = await bindFixturePane(request, target, sessionId);

    await request.post(`/api/workspaces/${other.id}/title`, { data: { title: "Other pin survives outage" } });
    await request.post(`/api/workspaces/${other.id}/tabs/${otherTab}/title`, { data: { title: "Other tab survives outage" } });
    await request.post(`/api/workspaces/${target.id}/title`, { data: { title: "Pinned during outage" } });
    await request.post(`/api/workspaces/${target.id}/tabs/${targetTab}/title`, { data: { title: "Pinned tab during outage" } });

    // Withhold title delivery while metadata is unavailable. A late sample from
    // before recovery cannot acquire authority over either manual pin.
    await postTitle(request, {
      sessionId,
      receipt: challenge.receipt,
      title: "Stale outage sample",
    });
    const revoked = await request.post("/api/codex-bindings/revoke", {
      data: { sessionId, receipts: [challenge.receipt] },
    });
    expect(revoked.ok()).toBeTruthy();
    await request.post(`/api/workspaces/${target.id}/title`, { data: { clear: true } });
    await request.post(`/api/workspaces/${target.id}/tabs/${targetTab}/title`, { data: { clear: true } });

    let state = await snapshot(request);
    let current = state.workspaces.find((workspace) => workspace.id === target!.id)!;
    expect(current).toMatchObject({ nameSource: "default" });
    expect(current.tabs.find((tab) => tab.id === targetTab)).toMatchObject({ titleSource: "default" });

    const staleAfterUnpin = await request.post("/api/codex-bindings/title", {
      data: {
        sessionId,
        receipt: challenge.receipt,
        title: "Stale sample must not revive",
        mode: "auto",
      },
    });
    expect(staleAfterUnpin.status()).toBe(404);

    const fresh = await bindFixturePane(request, target, sessionId);
    // This second request represents metadata read only after health recovery
    // and a fresh receipt proof; it is the sole authority allowed to restore.
    await postTitle(request, {
      sessionId,
      receipt: fresh.receipt,
      title: "Current native metadata after recovery",
    });
    state = await snapshot(request);
    current = state.workspaces.find((workspace) => workspace.id === target!.id)!;
    const untouched = state.workspaces.find((workspace) => workspace.id === other!.id)!;
    expect(current).toMatchObject({
      name: "Current native metadata after recovery", nameSource: "auto",
    });
    expect(current.tabs.find((tab) => tab.id === targetTab)).toMatchObject({
      title: "Current native metadata after recovery", titleSource: "auto",
    });
    expect(untouched).toMatchObject({ name: "Other pin survives outage", nameSource: "user" });
    expect(untouched.tabs.find((tab) => tab.id === otherTab)).toMatchObject({
      title: "Other tab survives outage", titleSource: "user",
    });
  } finally {
    if (target) await request.delete(`/api/workspaces/${target.id}`).catch(() => undefined);
    if (other) await request.delete(`/api/workspaces/${other.id}`).catch(() => undefined);
  }
});
