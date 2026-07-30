import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  classifyOpenCodeQuestionReplyResult,
  isSupportedOpenCodeQuestionRuntime,
  OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
  sanitizeOpenCodeQuestionEvent,
  SUPPORTED_OPENCODE_SDK_VERSION,
  type OpenCodeQuestionReply,
} from "../src/server/opencode-question-contract.js";

const fixtureDirectory = path.join(process.cwd(), "test", "fixtures", "opencode-question");
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8"));

test("supported OpenCode manifest pins the official SDK contract", () => {
  const manifest = fixture("supported-manifest.json") as Record<string, unknown>;
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(manifest.sdkVersion, "1.18.9");
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
  const supported = {
    client: { question: { reply: () => undefined } },
    sdkVersion: SUPPORTED_OPENCODE_SDK_VERSION,
    pluginVersion: SUPPORTED_OPENCODE_SDK_VERSION,
    compatibilityFingerprint: OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
  };
  assert.equal(isSupportedOpenCodeQuestionRuntime(supported), true);
  assert.equal(isSupportedOpenCodeQuestionRuntime({ ...supported, client: {} }), false);
  assert.equal(isSupportedOpenCodeQuestionRuntime({ ...supported, sdkVersion: "future" }), false);
  assert.equal(isSupportedOpenCodeQuestionRuntime({ ...supported, compatibilityFingerprint: "wrong" }), false);
  assert.deepEqual(sanitizeOpenCodeQuestionEvent({ type: "question.asked", properties: {} }), {
    kind: "unsupported", code: "incompatible_event_shape",
  });
  assert.deepEqual(sanitizeOpenCodeQuestionEvent({ type: "question.future", properties: {} }), {
    kind: "unsupported", code: "incompatible_event_shape",
  });
});
