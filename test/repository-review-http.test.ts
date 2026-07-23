import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { issueSessionToken, type AuthConfig } from "../src/server/auth.js";
import { createHttpServer } from "../src/server/http.js";
import { RepositoryReviewService } from "../src/server/repository-review.js";
import type { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import type { MachineConfig } from "../src/server/types.js";

const git = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

interface HttpFixture {
  directory: string;
  repository: string;
  state: StateStore;
  localPaneId: string;
  remotePaneId: string;
  nonRepositoryPaneId: string;
  auth: AuthConfig;
  sessionToken: string;
  server: Awaited<ReturnType<typeof createHttpServer>>;
  baseUrl: string;
}

const createFixture = async (): Promise<HttpFixture> => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-repository-http-"));
  const repository = path.join(directory, "canonical repo");
  const nonRepository = path.join(directory, "not a repo");
  fs.mkdirSync(repository);
  fs.mkdirSync(nonRepository);
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.name", "wmux test"]);
  git(repository, ["config", "user.email", "wmux@example.invalid"]);
  fs.writeFileSync(path.join(repository, "tracked.txt"), "baseline\n");
  git(repository, ["add", "--", "tracked.txt"]);
  git(repository, ["commit", "-qm", "baseline"]);
  fs.writeFileSync(path.join(repository, "tracked.txt"), "changed\n");
  fs.writeFileSync(path.join(repository, "untracked.txt"), "untracked\n");

  const machines: MachineConfig[] = [
    { id: "local", name: "Local", kind: "local" },
    { id: "remote", name: "Remote", kind: "ssh", host: "example.invalid", user: "wmux" },
  ];
  const state = new StateStore(machines, path.join(directory, "state.json"));
  const localPaneId = state.createWorkspace("local", repository).tabs[0].panes[0].id;
  const remotePaneId = state.createWorkspace("remote", repository).tabs[0].panes[0].id;
  const nonRepositoryPaneId = state.createWorkspace("local", nonRepository).tabs[0].panes[0].id;
  const auth: AuthConfig = {
    enabled: true,
    token: "legacy-shared-token",
    loginEnabled: true,
    sessionSecret: "repository-http-session-secret",
    browserAuthMode: "login-only",
    automationToken: "A".repeat(43),
    helperToken: "H".repeat(43),
  };
  const sessionToken = issueSessionToken(auth.sessionSecret, 60_000, Date.now());
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const repositoryReviews = new RepositoryReviewService(state, machines, {
    limits: {
      fileCount: 20,
      patchBytes: 128 * 1024,
    },
  });
  const server = await createHttpServer(
    "127.0.0.1",
    state,
    machines,
    {} as SessionManager,
    settings,
    {
      auth,
      registrationToken: "R".repeat(43),
      repositoryReviews,
      healthResolvers: { machines: async () => [], streams: async () => [] },
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    directory,
    repository,
    state,
    localPaneId,
    remotePaneId,
    nonRepositoryPaneId,
    auth,
    sessionToken,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const closeFixture = async (fixture: HttpFixture): Promise<void> => {
  fixture.server.close();
  await once(fixture.server, "close");
  fixture.state.flush();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
};

const postReview = (
  fixture: HttpFixture,
  paneId: string,
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Response> =>
  fetch(`${fixture.baseUrl}/api/panes/${encodeURIComponent(paneId)}/reviews`, {
    method: "POST",
    headers,
    body,
  });

test("repository review HTTP route grants normal browser access only", async () => {
  const fixture = await createFixture();
  try {
    const body = JSON.stringify({ kind: "working-tree" });
    assert.equal((await postReview(fixture, fixture.localPaneId, body)).status, 401);
    assert.equal((await postReview(
      fixture,
      fixture.localPaneId,
      body,
      bearer(fixture.auth.automationToken!),
    )).status, 403);
    assert.equal((await postReview(
      fixture,
      fixture.localPaneId,
      body,
      bearer(fixture.auth.helperToken!),
    )).status, 403);
    assert.equal((await postReview(
      fixture,
      fixture.localPaneId,
      body,
      bearer(fixture.auth.token),
    )).status, 401);
    assert.equal((await postReview(
      fixture,
      fixture.localPaneId,
      body,
      bearer("R".repeat(43)),
    )).status, 401);

    const browser = await postReview(
      fixture,
      fixture.localPaneId,
      body,
      bearer(fixture.sessionToken),
    );
    assert.equal(browser.status, 201);
    assert.equal(browser.headers.get("cache-control"), "no-store");
    const payload = await browser.json() as {
      snapshot: {
        kind: string;
        files: Array<{ path: string }>;
        workingTreePatch: { text: string };
      };
    };
    assert.equal(payload.snapshot.kind, "working-tree");
    assert.ok(payload.snapshot.files.some((file) => file.path === "tracked.txt"));
    assert.ok(payload.snapshot.files.some((file) => file.path === "untracked.txt"));
    assert.match(payload.snapshot.workingTreePatch.text, /\+changed/);
  } finally {
    await closeFixture(fixture);
  }
});

test("repository review HTTP route uses canonical pane state and rejects client targeting fields", async () => {
  const fixture = await createFixture();
  try {
    const response = await postReview(
      fixture,
      fixture.localPaneId,
      JSON.stringify({
        kind: "working-tree",
        cwd: "/tmp/client-selected",
        repositoryRoot: "/tmp/other",
        host: "remote.example",
        executable: "not-git",
        arguments: ["push", "--force"],
      }),
      bearer(fixture.sessionToken),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_repository_review_request" });

    const canonical = await postReview(
      fixture,
      fixture.localPaneId,
      JSON.stringify({ kind: "working-tree" }),
      bearer(fixture.sessionToken),
    );
    const payload = await canonical.json() as { snapshot: { files: Array<{ path: string }> } };
    assert.equal(canonical.status, 201);
    assert.ok(payload.snapshot.files.some((file) => file.path === "tracked.txt"));
  } finally {
    await closeFixture(fixture);
  }
});

test("repository review HTTP route returns stable typed target and repository errors", async () => {
  const fixture = await createFixture();
  try {
    const headers = bearer(fixture.sessionToken);
    const body = JSON.stringify({ kind: "working-tree" });
    const unknown = await postReview(fixture, "pane_missing", body, headers);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "pane_not_found" });

    const remote = await postReview(fixture, fixture.remotePaneId, body, headers);
    assert.equal(remote.status, 422);
    assert.deepEqual(await remote.json(), { error: "repository_review_non_local" });

    const nonRepository = await postReview(fixture, fixture.nonRepositoryPaneId, body, headers);
    assert.equal(nonRepository.status, 422);
    assert.deepEqual(await nonRepository.json(), { error: "repository_not_found" });
  } finally {
    await closeFixture(fixture);
  }
});

test("repository review HTTP route rejects malformed and unsupported requests", async () => {
  const fixture = await createFixture();
  try {
    const headers = bearer(fixture.sessionToken);
    for (const body of [
      "{}",
      "null",
      "[]",
      JSON.stringify({ kind: "commit" }),
      JSON.stringify({ kind: "working-tree", extra: true }),
    ]) {
      const response = await postReview(fixture, fixture.localPaneId, body, headers);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_repository_review_request" });
    }
    const invalidJson = await postReview(fixture, fixture.localPaneId, "{", headers);
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), { error: "invalid_json" });
  } finally {
    await closeFixture(fixture);
  }
});
