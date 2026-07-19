import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import {
  canApplyStagedPasteImage,
  imagesFromClipboard,
  quoteStagedImagePath,
} from "../src/client/src/clipboard-images.js";
import { createHttpServer } from "../src/server/http.js";
import {
  MAX_PASTE_IMAGE_BYTES,
  PasteImageStageError,
  PasteImageStaging,
  posixPasteImageDeleteScript,
  posixPasteImageStageScript,
  powershellPasteImageDeleteScript,
  powershellPasteImageStageScript,
  runBinarySsh,
  type PasteImageStager,
  type StagedPasteImage,
  validatePasteImage,
} from "../src/server/paste-image-staging.js";
import { SessionManager } from "../src/server/session-manager.js";
import { SettingsStore } from "../src/server/settings.js";
import { StateStore } from "../src/server/state.js";
import { sshControlOnlyArgs, sshControlPath } from "../src/server/ssh-control.js";
import type { MachineConfig } from "../src/server/types.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test("paste image validation recognizes only the four accepted magic headers", () => {
  assert.deepEqual(validatePasteImage(png), { mimeType: "image/png", extension: "png" });
  assert.deepEqual(validatePasteImage(Buffer.from([0xff, 0xd8, 0xff, 0x00])), {
    mimeType: "image/jpeg",
    extension: "jpg",
  });
  assert.deepEqual(validatePasteImage(Buffer.from("GIF89a!", "ascii")), {
    mimeType: "image/gif",
    extension: "gif",
  });
  assert.deepEqual(validatePasteImage(Buffer.from("RIFF0000WEBP", "ascii")), {
    mimeType: "image/webp",
    extension: "webp",
  });
  assert.throws(
    () => validatePasteImage(Buffer.from("<svg/>", "ascii")),
    (error: unknown) => error instanceof PasteImageStageError && error.status === 415,
  );
  assert.throws(
    () => validatePasteImage(Buffer.alloc(MAX_PASTE_IMAGE_BYTES + 1, 0x89)),
    (error: unknown) => error instanceof PasteImageStageError && error.status === 413,
  );
});

test("local staging creates private generated files and discard is pane scoped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-paste-images-"));
  const staging = new PasteImageStaging(root);
  try {
    const staged = await staging.stage("pane-local", { id: "local", name: "Local", kind: "local" }, png);
    assert.match(staged.stageId, /^paste-[0-9a-f]{36}$/);
    assert.equal(staged.mimeType, "image/png");
    assert.equal(staged.bytes, png.length);
    assert.ok(staged.targetPath.startsWith(`${root}${path.sep}`));
    assert.deepEqual(fs.readFileSync(staged.targetPath), png);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.dirname(staged.targetPath)).mode & 0o777, 0o700);
      assert.equal(fs.statSync(staged.targetPath).mode & 0o777, 0o600);
    }
    assert.equal(await staging.discard("other-pane", staged.stageId), false);
    assert.equal(fs.existsSync(staged.targetPath), true);
    assert.equal(await staging.discard("pane-local", staged.stageId), true);
    assert.equal(fs.existsSync(staged.targetPath), false);
  } finally {
    staging.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local startup sweep expires only generated image stages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-paste-sweep-"));
  const paneDirectory = path.join(root, "c".repeat(24));
  fs.mkdirSync(paneDirectory);
  const generated = path.join(paneDirectory, `paste-${"d".repeat(36)}.png`);
  const unrelated = path.join(paneDirectory, "keep.txt");
  fs.writeFileSync(generated, png);
  fs.writeFileSync(unrelated, "keep");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(generated, old, old);
  fs.utimesSync(unrelated, old, old);
  const staging = new PasteImageStaging(root);
  try {
    assert.equal(fs.existsSync(generated), false);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    staging.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("custom-command, service, and legacy PowerShell targets fail closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-paste-unsupported-"));
  const staging = new PasteImageStaging(root);
  const machines: MachineConfig[] = [
    { id: "command", name: "Command", kind: "local", command: ["/bin/sh"] },
    { id: "service", name: "Service", kind: "service" },
    { id: "wsman", name: "WSMan", kind: "powershell", host: "windows" },
  ];
  try {
    for (const machine of machines) {
      await assert.rejects(
        staging.stage("pane", machine, png),
        (error: unknown) => error instanceof PasteImageStageError
          && error.status === 422
          && error.code === "paste_image_target_unsupported",
      );
    }
  } finally {
    staging.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staged path quoting is shell-specific and rejects terminal controls", () => {
  assert.equal(quoteStagedImagePath("/tmp/wmux/it's.png"), "'/tmp/wmux/it'\\''s.png'");
  assert.equal(quoteStagedImagePath("C:\\Users\\O'Brien\\image.png"), "'C:\\Users\\O''Brien\\image.png'");
  for (const invalid of ["relative.png", "/tmp/bad\nname", "/tmp/bad\x1bname"]) {
    assert.throws(() => quoteStagedImagePath(invalid), /Invalid staged image path|not absolute/);
  }
});

test("async paste guard rejects pane, input, activity, visibility, and connection changes", () => {
  const captured = { paneId: "pane-a", inputEpoch: 4 };
  const current = {
    ...captured,
    mounted: true,
    active: true,
    visible: true,
    connected: true,
  };
  assert.equal(canApplyStagedPasteImage(captured, current), true);
  assert.equal(canApplyStagedPasteImage(captured, { ...current, paneId: "pane-b" }), false);
  assert.equal(canApplyStagedPasteImage(captured, { ...current, inputEpoch: 5 }), false);
  for (const key of ["mounted", "active", "visible", "connected"] as const) {
    assert.equal(canApplyStagedPasteImage(captured, { ...current, [key]: false }), false);
  }
});

test("clipboard extraction keeps mobile's custom image acceptance while terminal defaults are strict", () => {
  const pngFile = { type: "image/png" } as File;
  const svgFile = { type: "image/svg+xml" } as File;
  const clipboard = {
    items: [
      { kind: "file", type: pngFile.type, getAsFile: () => pngFile },
      { kind: "file", type: svgFile.type, getAsFile: () => svgFile },
    ],
    files: [svgFile],
  };
  assert.deepEqual(imagesFromClipboard(clipboard), [pngFile]);
  assert.deepEqual(imagesFromClipboard(clipboard, (mimeType) => mimeType.startsWith("image/")), [pngFile, svgFile]);
});

test("remote staging scripts use private generated paths and reject injected identities", () => {
  const stageId = `paste-${"a".repeat(36)}`;
  assert.match(posixPasteImageStageScript(stageId, "png"), /umask 077/);
  assert.match(posixPasteImageStageScript(stageId, "png"), /chmod 600/);
  assert.match(posixPasteImageDeleteScript(stageId, "png"), new RegExp(stageId));
  assert.match(powershellPasteImageStageScript(stageId, "png"), /FileMode]::CreateNew/);
  assert.match(powershellPasteImageDeleteScript(stageId, "png"), /Remove-Item -LiteralPath/);
  assert.throws(() => posixPasteImageStageScript("paste-'; rm -rf -- /", "png"));
  assert.throws(() => powershellPasteImageDeleteScript(stageId, "png'; exit 0; #"));
});

test("control-only SSH execution cannot fall back after its master disappears", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-paste-control-only-"));
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  const received: Buffer[] = [];
  let connections = 0;
  const trap = net.createServer((socket) => {
    connections += 1;
    socket.on("data", (chunk) => received.push(Buffer.from(chunk)));
    socket.resume();
  });
  trap.listen(0, "127.0.0.1");
  await once(trap, "listening");
  const address = trap.address();
  assert.ok(address && typeof address === "object");
  const paneId = "pane-control-race";
  const controlPath = sshControlPath(paneId);
  fs.writeFileSync(controlPath, "former control socket", { mode: 0o600 });
  fs.rmSync(controlPath);
  try {
    await assert.rejects(runBinarySsh([
      "-T",
      "-o", "BatchMode=yes",
      ...sshControlOnlyArgs(paneId),
      "-p", String(address.port),
      "127.0.0.1",
      "cat",
    ], png), /SSH image staging failed|write EPIPE/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(connections, 0, "no fresh TCP transport may be opened");
    assert.equal(Buffer.concat(received).includes(png), false, "image bytes must not reach a fresh connection");
  } finally {
    trap.close();
    await once(trap, "close");
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});

const stagedResult = (stageId = `paste-${"b".repeat(36)}`): StagedPasteImage => ({
  stageId,
  targetPath: "/tmp/wmux/image.png",
  mimeType: "image/png",
  extension: "png",
  bytes: png.length,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

test("SessionManager waits for the live agent port and passes its pinned snapshot", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-paste-session-"));
  const machine: MachineConfig = {
    id: "agent",
    name: "Agent",
    kind: "powershell-ssh",
    host: "100.70.0.8",
    sessionBackend: "agent",
    agentPort: 3481,
  };
  const state = new StateStore([machine], path.join(directory, "state.json"));
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  let resolveAttach!: () => void;
  const attachReady = new Promise<void>((resolve) => { resolveAttach = resolve; });
  let stagedMachine: MachineConfig | undefined;
  const stager: PasteImageStager = {
    stage: async (_paneId, snapshot) => {
      stagedMachine = snapshot;
      return stagedResult();
    },
    discard: async () => true,
    cleanupPane: async () => undefined,
    dispose: () => undefined,
  };
  const manager = new SessionManager(state, [machine], "", undefined, undefined, stager);
  const internals = manager as unknown as {
    sessions: Map<string, { isExited: boolean; attachReady: Promise<void> }>;
    sessionMachines: Map<string, MachineConfig>;
  };
  internals.sessions.set(pane.id, { isExited: false, attachReady });
  internals.sessionMachines.set(pane.id, structuredClone(machine));
  try {
    const pending = manager.stagePasteImage(pane.id, png);
    internals.sessionMachines.set(pane.id, { ...machine, agentPort: 3490 });
    resolveAttach();
    await pending;
    assert.equal(stagedMachine?.agentPort, 3490);
    assert.equal(stagedMachine?.host, "100.70.0.8");
  } finally {
    internals.sessions.clear();
    manager.disposeAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SessionManager discards a stage that finishes after its pane session changes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-paste-race-"));
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local" };
  const state = new StateStore([machine], path.join(directory, "state.json"));
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  let finishStage!: () => void;
  const stageBlocked = new Promise<void>((resolve) => { finishStage = resolve; });
  const discarded: string[] = [];
  const stager: PasteImageStager = {
    stage: async () => {
      await stageBlocked;
      return stagedResult();
    },
    discard: async (_paneId, stageId) => {
      discarded.push(stageId);
      return true;
    },
    cleanupPane: async () => undefined,
    dispose: () => undefined,
  };
  const manager = new SessionManager(state, [machine], "", undefined, undefined, stager);
  const session = { isExited: false };
  const internals = manager as unknown as {
    sessions: Map<string, typeof session>;
    sessionMachines: Map<string, MachineConfig>;
  };
  internals.sessions.set(pane.id, session);
  internals.sessionMachines.set(pane.id, structuredClone(machine));
  try {
    const pending = manager.stagePasteImage(pane.id, png);
    internals.sessions.delete(pane.id);
    finishStage();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof PasteImageStageError && error.code === "paste_image_pane_not_live",
    );
    assert.deepEqual(discarded, [stagedResult().stageId]);
  } finally {
    manager.disposeAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SessionManager discards a stage when pane input changes concurrently", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-paste-input-race-"));
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local" };
  const state = new StateStore([machine], path.join(directory, "state.json"));
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  let finishStage!: () => void;
  const stageBlocked = new Promise<void>((resolve) => { finishStage = resolve; });
  const discarded: string[] = [];
  const stager: PasteImageStager = {
    stage: async () => {
      await stageBlocked;
      return stagedResult();
    },
    discard: async (_paneId, stageId) => {
      discarded.push(stageId);
      return true;
    },
    cleanupPane: async () => undefined,
    dispose: () => undefined,
  };
  const manager = new SessionManager(state, [machine], "", undefined, undefined, stager);
  const session = { isExited: false };
  const internals = manager as unknown as {
    sessions: Map<string, typeof session>;
    sessionMachines: Map<string, MachineConfig>;
    paneInputEpochs: Map<string, number>;
  };
  internals.sessions.set(pane.id, session);
  internals.sessionMachines.set(pane.id, structuredClone(machine));
  try {
    const pending = manager.stagePasteImage(pane.id, png);
    internals.paneInputEpochs.set(pane.id, 1);
    finishStage();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof PasteImageStageError && error.code === "paste_image_input_changed",
    );
    assert.deepEqual(discarded, [stagedResult().stageId]);
  } finally {
    internals.sessions.clear();
    manager.disposeAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("pane paste image HTTP endpoint authenticates and accepts only bounded raw binary", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-paste-http-"));
  const machine: MachineConfig = { id: "local", name: "Local", kind: "local" };
  const state = new StateStore([machine], path.join(directory, "state.json"));
  const settings = new SettingsStore(path.join(directory, "settings.json"));
  const pane = state.snapshot().workspaces[0].tabs[0].panes[0];
  const stagedBodies: Buffer[] = [];
  const sessions = {
    hasLivePaneSession: (paneId: string) => paneId === pane.id,
    stagePasteImage: async (_paneId: string, data: Buffer) => {
      stagedBodies.push(data);
      return stagedResult();
    },
  } as unknown as SessionManager;
  const server = await createHttpServer("127.0.0.1", state, [machine], sessions, settings, {
    auth: { enabled: true, token: "paste-token", loginEnabled: false, sessionSecret: "test" },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/panes/${encodeURIComponent(pane.id)}/paste-images`;
  try {
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: png,
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(stagedBodies.length, 0);

    const wrongType = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer paste-token", "content-type": "image/png" },
      body: png,
    });
    assert.equal(wrongType.status, 415);
    assert.equal(stagedBodies.length, 0);

    const accepted = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer paste-token", "content-type": "application/octet-stream" },
      body: png,
    });
    assert.equal(accepted.status, 201);
    assert.deepEqual(stagedBodies, [png]);
    assert.equal((await accepted.json() as { targetPath: string }).targetPath, stagedResult().targetPath);

    const oversizedStatus = await new Promise<number>((resolve, reject) => {
      const request = http.request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer paste-token",
          "content-type": "application/octet-stream",
          "content-length": String(MAX_PASTE_IMAGE_BYTES + 1),
        },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(oversizedStatus, 413);
    assert.equal(stagedBodies.length, 1);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
