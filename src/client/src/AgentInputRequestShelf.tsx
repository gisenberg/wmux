import { useEffect, useMemo, useRef, useState } from "react";
import { api, UnauthorizedError } from "./api";
import type { AgentInputAnswerResult, AgentInputQuestion, AgentInputRequest } from "./types";
import {
  buildAgentInputAnswers,
  newAgentInputSubmissionId,
  validAgentInputAnswers,
} from "./agent-input-reference";

interface AgentInputRequestShelfProps {
  requests: AgentInputRequest[];
  onOpenTerminal: () => void;
}

export const AgentInputRequestShelf = ({ requests, onOpenTerminal }: AgentInputRequestShelfProps) => (
  <aside className="agent-input-shelf" aria-label="OpenCode questions">
    {requests.map((request) => (
      <AgentInputRequestCard key={request.id} request={request} onOpenTerminal={onOpenTerminal} />
    ))}
  </aside>
);

const AgentInputRequestCard = ({
  request,
  onOpenTerminal,
}: {
  request: AgentInputRequest;
  onOpenTerminal: () => void;
}) => {
  const [selected, setSelected] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AgentInputAnswerResult | undefined>();
  const submissionId = useRef(newAgentInputSubmissionId());
  const requestIdentity = `${request.id}:${request.generation}`;
  const priorIdentity = useRef(requestIdentity);
  const resetMarker = useRef("");
  const answers = useMemo(
    () => buildAgentInputAnswers(request.questions, selected, custom),
    [custom, request.questions, selected],
  );
  const valid = validAgentInputAnswers(request.questions, answers);
  const editable = request.state === "pending" && !submitting;
  const submit = async () => {
    if (!valid || !editable) return;
    setSubmitting(true);
    try {
      setResult(await api.answerAgentInputRequest(
        request.id,
        request.generation,
        submissionId.current,
        answers,
      ));
    } catch (error) {
      if (error instanceof UnauthorizedError) return;
      setResult({ outcome: "source_unavailable" });
    } finally {
      setSubmitting(false);
    }
  };
  useEffect(() => {
    if (priorIdentity.current !== requestIdentity) {
      priorIdentity.current = requestIdentity;
      resetMarker.current = `identity:${requestIdentity}`;
      submissionId.current = newAgentInputSubmissionId();
      setResult(undefined);
      setSelected(request.questions.map(() => []));
      setCustom(request.questions.map(() => ""));
      return;
    }
    if (request.state !== "pending") {
      const marker = `state:${requestIdentity}:${request.state}`;
      if (resetMarker.current === marker) return;
      resetMarker.current = marker;
      setResult(undefined);
      setSelected(request.questions.map(() => []));
      setCustom(request.questions.map(() => ""));
      return;
    }
  }, [request.questions, request.state, requestIdentity, result]);
  const toggle = (question: AgentInputQuestion, questionIndex: number, label: string) => {
    if (!editable) return;
    setSelected((current) => current.map((values, index) => {
      if (index !== questionIndex) return values;
      if (!question.multiple) return [label];
      return values.includes(label) ? values.filter((value) => value !== label) : [...values, label];
    }));
    if (!question.multiple) setCustom((current) => current.map((value, index) => index === questionIndex ? "" : value));
  };
  const displayState = request.state === "pending"
    ? result?.outcome ?? (submitting ? "submitting" : request.state)
    : request.state;
  return (
    <section className="agent-input-card" data-request-id={request.id} data-state={displayState} tabIndex={-1}>
      <header><strong>[INPUT] OPENCODE</strong><span>{displayState.replaceAll("_", " ")}</span></header>
      {request.questions.map((question, questionIndex) => (
        <fieldset key={`${request.id}:${questionIndex}`} disabled={!editable}>
          <legend>{question.header}</legend>
          <p>{question.question}</p>
          {question.options.map((option) => (
            <label key={option.label}>
              <input
                type={question.multiple ? "checkbox" : "radio"}
                name={`${request.id}:${questionIndex}`}
                checked={selected[questionIndex].includes(option.label)}
                onChange={() => toggle(question, questionIndex, option.label)}
              />
              <span>{option.label}<small>{option.description}</small></span>
            </label>
          ))}
          {question.custom ? (
            <input
              className="agent-input-custom"
              aria-label={`${question.header} custom answer`}
              value={custom[questionIndex]}
              maxLength={4096}
              placeholder="Custom response"
              onChange={(event) => {
                const value = event.target.value;
                setCustom((current) => current.map((item, index) => index === questionIndex ? value : item));
                if (!question.multiple && value) setSelected((current) => current.map((item, index) => index === questionIndex ? [] : item));
              }}
            />
          ) : null}
        </fieldset>
      ))}
      <footer>
        <button type="button" onClick={onOpenTerminal}>[T] OPEN TERMINAL</button>
        <button type="button" disabled={!valid || !editable} onClick={() => void submit()}>
          {submitting ? "SUBMITTING" : "[ENTER] SUBMIT"}
        </button>
      </footer>
    </section>
  );
};
