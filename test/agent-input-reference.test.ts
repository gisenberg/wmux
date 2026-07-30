import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentInputAnswers,
  newAgentInputSubmissionId,
  validAgentInputAnswer,
} from "../src/client/src/agent-input-reference.js";
import { api } from "../src/client/src/api.js";
import type { AgentInputQuestion } from "../src/shared/protocol.js";

const questions: AgentInputQuestion[] = [
  { header: "Mode", question: "Choose one", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: false },
  { header: "Checks", question: "Choose checks", options: [{ label: "Tests", description: "Tests" }, { label: "Types", description: "Types" }], multiple: true, custom: false },
  { header: "Note", question: "Custom", options: [], multiple: false, custom: true },
];

test("reference harness maps single, multi, and custom answers in exact question order", () => {
  const answers = buildAgentInputAnswers(questions, [["Safe"], ["Types", "Tests"], []], ["", "", "  custom note  "]);
  assert.deepEqual(answers, [["Safe"], ["Types", "Tests"], ["custom note"]]);
  assert.equal(questions.every((question, index) => validAgentInputAnswer(question, answers[index])), true);
  assert.equal(validAgentInputAnswer(questions[0], []), false);
  assert.equal(validAgentInputAnswer(questions[1], ["Tests", "Tests"]), false);
  assert.equal(validAgentInputAnswer(questions[0], ["custom mode"]), false,
    "explicit custom false rejects values outside the option set");
  assert.equal(validAgentInputAnswer(questions[2], ["custom note"]), true,
    "projected custom true accepts one custom value");
  assert.deepEqual(buildAgentInputAnswers(questions, [[], [], []], ["blocked", "blocked", "allowed"]), [
    [], [], ["allowed"],
  ], "the browser maps custom text only for questions projected with custom true");
});

test("reference harness creates a stable caller-owned submission id", () => {
  const id = newAgentInputSubmissionId();
  assert.ok(id.length > 8);
  const retainedAcrossRetries = id;
  assert.equal(retainedAcrossRetries, id);
});

test("reference answer retries use only the user CAS route and emit zero pane-input requests", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; method?: string; body?: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(input), method: init?.method, body: init?.body as string | undefined });
    return new Response(JSON.stringify({ outcome: "source_unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const submissionId = newAgentInputSubmissionId();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(await api.answerAgentInputRequest("request / one", 3, submissionId, [["private answer"]]), {
        outcome: "source_unavailable",
      });
    }
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.path === "/api/agent-input/requests/request%20%2F%20one/answer"
      && call.method === "POST"));
    assert.ok(calls.every((call) => JSON.parse(call.body ?? "{}").idempotencyKey === submissionId));
    assert.equal(calls.filter((call) => /pane|input/i.test(call.path.replace("agent-input", ""))).length, 0,
      "answer flow must not call a pane-input transport");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
