import type { AgentInputQuestion } from "./types";

const MAX_ANSWER_VALUE_BYTES = 4_096;
const MAX_ANSWER_BYTES = 16_384;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

export const buildAgentInputAnswers = (
  questions: AgentInputQuestion[],
  selected: string[][],
  custom: string[],
): string[][] => questions.map((question, index) => [
  ...(selected[index] ?? []),
  ...(question.custom && custom[index]?.trim() ? [custom[index].trim()] : []),
]);

export const validAgentInputAnswer = (question: AgentInputQuestion, answers: string[]): boolean => {
  if (answers.length === 0 || (!question.multiple && answers.length !== 1)) return false;
  if (new Set(answers).size !== answers.length) return false;
  if (answers.some((answer) => utf8Bytes(answer) > MAX_ANSWER_VALUE_BYTES)) return false;
  const labels = new Set(question.options.map((option) => option.label));
  const customCount = answers.filter((answer) => !labels.has(answer)).length;
  return customCount <= (question.custom ? 1 : 0);
};

export const validAgentInputAnswers = (questions: AgentInputQuestion[], answers: string[][]): boolean =>
  answers.length === questions.length
  && questions.every((question, index) => validAgentInputAnswer(question, answers[index] ?? []))
  && answers.flat().reduce((total, answer) => total + utf8Bytes(answer), 0) <= MAX_ANSWER_BYTES;

export const newAgentInputSubmissionId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `submission-${Date.now()}-${Math.random()}`;
