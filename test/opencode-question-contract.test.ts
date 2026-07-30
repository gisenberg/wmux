import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  classifyOpenCodeQuestionReplyResult,
  createOpenCodeRuntimeAttestation,
  isSupportedOpenCodeQuestionRuntime,
  OPENCODE_QUESTION_CONTRACT_DIGEST,
  sanitizeOpenCodeQuestionEvent,
  type OpenCodeQuestionReply,
} from "../src/server/opencode-question-contract.js";

const fixtureDirectory = path.join(process.cwd(), "test", "fixtures", "opencode-question");
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8"));

test("supported OpenCode manifest pins the official SDK contract", () => {
  const manifest = fixture("supported-manifest.json") as Record<string, unknown>;
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(manifest.sdkVersion, "1.18.9");
  assert.equal(manifest.healthCall, "client.global.health()");
  assert.equal(manifest.canonicalContractDigest, OPENCODE_QUESTION_CONTRACT_DIGEST);
  const contract = JSON.parse(fs.readFileSync(path.join(process.cwd(), "scripts", "opencode-question-contract.json"), "utf8"));
  const digest = contract.canonicalContractDigest;
  delete contract.canonicalContractDigest;
  const canonicalize = (value: any): any => Array.isArray(value) ? value.map(canonicalize)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
      : value;
  assert.equal(crypto.createHash("sha256").update(JSON.stringify(canonicalize(contract))).digest("hex"), digest);
  assert.equal(manifest.officialTagCommit, "4da7bb44c84e013fa53e9c5d02ac753d1435c81a");
  assert.equal(packageJson.dependencies["@opencode-ai/sdk"], "1.18.9");
  assert.equal(manifest.questionListCall, "client.question.list({ directory })");
  assert.equal(manifest.questionReplyCall, "client.question.reply({ requestID, answers }, { signal })");
  assert.equal(manifest.questionReplyResult, "RequestResult<QuestionReplyResponses, QuestionReplyErrors, false, fields>");
  assert.equal(manifest.questionIdentityOwner, "broker-occurrence-stream");
  assert.equal(manifest.questionSnapshotAuthority, "complete-validated-top-level-members");
  assert.equal(manifest.questionResolutionBinding, "exact-occurrence-public-id-generation");
});

test("question fixtures validate and replied answers are dropped before the broker boundary", () => {
  const asked = sanitizeOpenCodeQuestionEvent(fixture("question-asked.json"));
  assert.equal(asked.kind, "supported");
  if (asked.kind === "supported" && asked.event.type === "question.asked") {
    assert.equal(asked.event.properties.questions.length, 3);
    assert.deepEqual(asked.event.properties.questions.map((question) => [question.multiple ?? false, question.custom ?? false]), [
      [false, false], [true, false], [false, true],
    ]);
  }
  assert.equal(sanitizeOpenCodeQuestionEvent(fixture("question-replied-identity.json")).kind, "supported");
  assert.equal(sanitizeOpenCodeQuestionEvent(fixture("question-rejected.json")).kind, "supported");
  assert.equal(sanitizeOpenCodeQuestionEvent(fixture("permission-asked.json")).kind, "ignored");
  assert.equal(sanitizeOpenCodeQuestionEvent(fixture("permission-replied.json")).kind, "ignored");

  const sentinel = ["RAW", "ANSWER", "SENTINEL"].join("_");
  const sanitized = sanitizeOpenCodeQuestionEvent({
    id: "event",
    type: "question.replied",
    properties: { requestID: "request", sessionID: "session", answers: [[sentinel]] },
  });
  assert.equal(sanitized.kind, "supported");
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(sentinel));
  for (const name of fs.readdirSync(fixtureDirectory)) {
    assert.doesNotMatch(fs.readFileSync(path.join(fixtureDirectory, name), "utf8"), new RegExp(sentinel));
  }
});

test("reply input and RequestResult behavior stay derived from OpencodeClient", () => {
  const input: OpenCodeQuestionReply = { requestID: "request", answers: [["Safe"]] };
  const compileCall = (client: OpencodeClient) => client.question.reply(input);
  assert.equal(typeof compileCall, "function");
  assert.deepEqual(classifyOpenCodeQuestionReplyResult({ data: true, error: undefined, response: { status: 200 } }), { outcome: "applied" });
  assert.deepEqual(classifyOpenCodeQuestionReplyResult({ data: undefined, error: { _tag: "InvalidRequestError" }, response: { status: 400 } }), {
    outcome: "sdk_error", code: "InvalidRequest", retryable: false,
  });
  assert.deepEqual(classifyOpenCodeQuestionReplyResult({ data: undefined, error: { _tag: "QuestionNotFoundError" }, response: { status: 404 } }), {
    outcome: "already_resolved",
  });
  assert.equal(classifyOpenCodeQuestionReplyResult(true).outcome, "unsupported");
  assert.deepEqual(classifyOpenCodeQuestionReplyResult({ data: undefined, error: {}, response: { status: 503 } }), {
    outcome: "sdk_error", code: "http_503", retryable: true,
  });
});

test("runtime compatibility fails closed for missing APIs, versions, fingerprints, and event shapes", () => {
  const supported = createOpenCodeRuntimeAttestation("N".repeat(43));
  assert.equal(isSupportedOpenCodeQuestionRuntime(supported), true);
  assert.equal(isSupportedOpenCodeQuestionRuntime({ ...supported, capabilities: { ...supported.capabilities, questionReply: false } }), false);
  assert.equal(isSupportedOpenCodeQuestionRuntime({ ...supported, release: "future" }), false);
  assert.equal(isSupportedOpenCodeQuestionRuntime(createOpenCodeRuntimeAttestation(
    "F".repeat(43), undefined, Date.now() + 60_000,
  )), false);
  assert.equal(isSupportedOpenCodeQuestionRuntime({ ...supported, compatibilityFingerprint: "wrong" }), false);
  assert.deepEqual(sanitizeOpenCodeQuestionEvent({ type: "question.asked", properties: {} }), {
    kind: "unsupported", code: "incompatible_event_shape",
  });
  assert.deepEqual(sanitizeOpenCodeQuestionEvent({ type: "question.future", properties: {} }), {
    kind: "unsupported", code: "incompatible_event_shape",
  });
});
