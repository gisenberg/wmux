import type { AgentInputQuestion } from "./types";

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
  const labels = new Set(question.options.map((option) => option.label));
  const customCount = answers.filter((answer) => !labels.has(answer)).length;
  return customCount <= (question.custom ? 1 : 0);
};

export const newAgentInputSubmissionId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `submission-${Date.now()}-${Math.random()}`;
