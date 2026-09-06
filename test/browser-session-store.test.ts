import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BrowserSessionStore,
  UnsupportedBrowserSessionVersionError,
} from "../src/server/browser-session-store.js";

test("browser sessions persist owner-only digests and survive restart", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-browser-sessions-"),
  );
  const filePath = path.join(directory, "browser-sessions.json");
  try {
    const nowMs = Date.now();
    const issued = new BrowserSessionStore("session-secret", filePath)
      .issue(60_000, nowMs, {
        device: "Test Browser",
        address: "100.64.0.2",
      });
    const contents = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(contents, new RegExp(issued.token));
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

    const restored = new BrowserSessionStore(
      "session-secret",
      filePath,
    ).authenticate(issued.token, nowMs + 30_000);
    assert.equal(restored?.id, issued.id);
    assert.equal(restored?.expiresAt, issued.expiresAt);
    assert.equal(restored?.device, "Test Browser");
    assert.equal(restored?.address, "100.64.0.2");
    assert.equal(
      new BrowserSessionStore(
        "different-secret",
        filePath,
      ).authenticate(issued.token, nowMs + 30_000),
      undefined,
    );
    assert.equal(
      new BrowserSessionStore(
        "session-secret",
        filePath,
      ).authenticate(issued.token, nowMs + 120_000),
      undefined,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser session files recover from backup and refuse downgrade", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-browser-session-recovery-"),
  );
  const filePath = path.join(directory, "browser-sessions.json");
  try {
    const store = new BrowserSessionStore("session-secret", filePath);
    const first = store.issue(60_000);
    store.issue(60_000);
    fs.writeFileSync(filePath, "{corrupt");
    assert.equal(
      new BrowserSessionStore(
        "session-secret",
        filePath,
      ).authenticate(first.token)?.id,
      first.id,
    );
    assert.equal(
      fs.readdirSync(directory).some((entry) =>
        entry.includes(".corrupt-")),
      true,
    );

    const future = JSON.stringify({
      schemaVersion: 3,
      sessions: [],
    });
    fs.writeFileSync(filePath, future, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    assert.throws(
      () => new BrowserSessionStore("session-secret", filePath),
      UnsupportedBrowserSessionVersionError,
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), future);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser sessions migrate v1 metadata and revoke subscribers immediately", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-browser-session-migration-"),
  );
  const filePath = path.join(directory, "browser-sessions.json");
  try {
    const nowMs = Date.now();
    const token = "t".repeat(43);
    const digest = crypto
      .createHmac("sha256", "session-secret")
      .update(token)
      .digest("hex");
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      sessions: [{
        id: "session_legacy",
        tokenDigest: digest,
        issuedAt: nowMs,
        expiresAt: nowMs + 60_000,
      }],
    }), { mode: 0o600 });
    const store = new BrowserSessionStore("session-secret", filePath);
    assert.deepEqual(store.list(nowMs), [{
      id: "session_legacy",
      issuedAt: nowMs,
      expiresAt: nowMs + 60_000,
      lastSeenAt: nowMs,
      device: "Unknown browser",
      address: "unknown",
    }]);
    const revoked: string[] = [];
    store.onRevoke((sessionId) => revoked.push(sessionId));
    assert.equal(store.revoke("session_legacy"), true);
    assert.deepEqual(revoked, ["session_legacy"]);
    assert.equal(store.authenticate(token, nowMs), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser session storage rejects unsafe parents and record files", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-browser-session-safety-"),
  );
  try {
    const unsafeParent = path.join(directory, "shared");
    fs.mkdirSync(unsafeParent, { mode: 0o755 });
    fs.chmodSync(unsafeParent, 0o755); // Exercise unsafe permissions even under umask 077.
    assert.throws(
      () => new BrowserSessionStore(
        "session-secret",
        path.join(unsafeParent, "sessions.json"),
      ).issue(60_000),
      /parent directory must be owner-only/,
    );

    const safeParent = path.join(directory, "private");
    fs.mkdirSync(safeParent, { mode: 0o700 });
    const filePath = path.join(safeParent, "sessions.json");
    new BrowserSessionStore("session-secret", filePath).issue(60_000);
    fs.chmodSync(filePath, 0o644);
    assert.throws(
      () => new BrowserSessionStore("session-secret", filePath),
      /permissions must be 0600/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
