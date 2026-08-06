import type { APIRequestContext, APIResponse } from "@playwright/test";

interface RequestOptions {
  data?: unknown;
  form?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  timeout?: number;
  failOnStatusCode?: boolean;
}

class NativeApiResponse {
  private readonly headerMap: Record<string, string>;

  constructor(
    private readonly response: Response,
    private readonly bytes: Buffer,
  ) {
    this.headerMap = Object.fromEntries(response.headers.entries());
  }

  ok = (): boolean => this.response.ok;
  status = (): number => this.response.status;
  statusText = (): string => this.response.statusText;
  url = (): string => this.response.url;
  headers = (): Record<string, string> => ({ ...this.headerMap });
  headersArray = (): Array<{ name: string; value: string }> =>
    Object.entries(this.headerMap).map(([name, value]) => ({ name, value }));
  body = async (): Promise<Buffer> => Buffer.from(this.bytes);
  text = async (): Promise<string> => this.bytes.toString("utf8");
  json = async (): Promise<unknown> => JSON.parse(this.bytes.toString("utf8"));
  dispose = async (): Promise<void> => {};
}

export const createExternalApiRequestContext = (
  baseURL: string,
  bearer: string,
): APIRequestContext => {
  const base = new URL(baseURL);
  const dispatch = async (method: string, input: string, options: RequestOptions = {}): Promise<APIResponse> => {
    const target = new URL(input, base);
    if (target.origin !== base.origin) throw new Error("External E2E API requests must remain on the configured wmux origin");
    for (const [key, value] of Object.entries(options.params ?? {})) target.searchParams.append(key, String(value));
    const headers = new Headers(options.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${bearer}`);
    let body: BodyInit | undefined;
    if (options.form) {
      body = new URLSearchParams(Object.entries(options.form).map(([key, value]) => [key, String(value)]));
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded");
    } else if (options.data !== undefined) {
      body = typeof options.data === "string" || options.data instanceof Uint8Array
        ? options.data as BodyInit
        : JSON.stringify(options.data);
      if (!headers.has("content-type") && typeof options.data !== "string") {
        headers.set("content-type", "application/json");
      }
    }
    const controller = new AbortController();
    const timer = options.timeout ? setTimeout(() => controller.abort(), options.timeout) : undefined;
    try {
      const response = await fetch(target, { method, headers, body, redirect: "manual", signal: controller.signal });
      const wrapped = new NativeApiResponse(response, Buffer.from(await response.arrayBuffer())) as unknown as APIResponse;
      if (options.failOnStatusCode && !response.ok) {
        throw new Error(`External E2E API request failed with HTTP ${response.status}`);
      }
      return wrapped;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const context = {
    fetch: (url: string, options?: RequestOptions & { method?: string }) =>
      dispatch(options?.method ?? "GET", url, options),
    get: (url: string, options?: RequestOptions) => dispatch("GET", url, options),
    post: (url: string, options?: RequestOptions) => dispatch("POST", url, options),
    put: (url: string, options?: RequestOptions) => dispatch("PUT", url, options),
    patch: (url: string, options?: RequestOptions) => dispatch("PATCH", url, options),
    delete: (url: string, options?: RequestOptions) => dispatch("DELETE", url, options),
    head: (url: string, options?: RequestOptions) => dispatch("HEAD", url, options),
    dispose: async () => {},
    storageState: async () => ({ cookies: [], origins: [] }),
  };
  return context as unknown as APIRequestContext;
};
