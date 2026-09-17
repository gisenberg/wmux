import { UnauthorizedError } from "./api";
import { authHeaders } from "./token";
import type {
  CodexTaskAssociation,
  CodexTaskDetail,
  CodexTaskEndpoint,
  CodexTaskLaunch,
  CodexTaskPage,
  CodexTaskTarget,
} from "../../shared/codex-tasks";
export class CodexTasksApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok) {
    try {
      throw new CodexTasksApiError(
        response.status,
        ((await response.json()) as { error?: string }).error ??
          `HTTP ${response.status}`,
      );
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new CodexTasksApiError(response.status, `HTTP ${response.status}`);
    }
  }
  return response.json() as Promise<T>;
};

export const codexTasksApi = {
  endpoints: () =>
    request<{ endpoints: CodexTaskEndpoint[] }>("/api/codex-tasks/endpoints"),
  list: (endpointId: string, cursor?: string | null, archived = false) =>
    request<CodexTaskPage>("/api/codex-tasks/list", {
      method: "POST",
      body: JSON.stringify({ endpointId, cursor, archived }),
    }),
  read: (endpointId: string, threadId: string, history = false) =>
    request<CodexTaskDetail>("/api/codex-tasks/read", {
      method: "POST",
      body: JSON.stringify({ endpointId, threadId, history }),
    }),
  associations: () =>
    request<{ associations: CodexTaskAssociation[] }>(
      "/api/codex-task-associations",
    ),
  associate: (input: {
    id?: string;
    endpointId: string;
    endpointIdentity: string;
    threadId: string;
    target: CodexTaskTarget;
  }) =>
    request<{ association: CodexTaskAssociation }>(
      "/api/codex-task-associations",
      { method: "POST", body: JSON.stringify(input) },
    ),
  removeAssociation: (id: string) =>
    request<{ removed: boolean }>(
      `/api/codex-task-associations/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  launch: (
    requestId: string,
    endpointId: string,
    endpointIdentity: string,
    cwd: string,
  ) =>
    request<{ launch: CodexTaskLaunch }>("/api/codex-task-launches", {
      method: "POST",
      body: JSON.stringify({ requestId, endpointId, endpointIdentity, cwd }),
    }),
  attach: (input: {
    requestId: string;
    endpointId: string;
    endpointIdentity: string;
    threadId: string;
    generation: string;
  }) =>
    request<{ launch: CodexTaskLaunch }>("/api/codex-task-launches", {
      method: "POST",
      body: JSON.stringify({ operation: "attach", ...input }),
    }),
  launches: () =>
    request<{ launches: CodexTaskLaunch[] }>("/api/codex-task-launches"),
  reconcileLaunch: (requestId: string) =>
    request<{ launch: CodexTaskLaunch }>(
      `/api/codex-task-launches/${encodeURIComponent(requestId)}`,
    ),
  acknowledgeLaunch: (requestId: string) =>
    request<{ launch: CodexTaskLaunch }>(
      `/api/codex-task-launches/${encodeURIComponent(requestId)}/acknowledge`,
      { method: "POST" },
    ),
};
