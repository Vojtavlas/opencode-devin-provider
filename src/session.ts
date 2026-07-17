import { APICallError } from "@ai-sdk/provider";

export interface DevinSessionResponse {
  session_id: string;
  status: string;
  url?: string;
  created_at?: number;
  org_id?: string;
  [key: string]: unknown;
}

export interface DevinSessionMessage {
  event_id: string;
  source: "devin" | "user";
  message: string;
  created_at: number;
  [key: string]: unknown;
}

export interface DevinPaginatedResponse<T> {
  items: T[];
  end_cursor?: string | null;
  has_next_page?: boolean;
  total?: number | null;
}

export interface CreateSessionArgs {
  baseURL: string;
  orgId: string;
  apiKey: string;
  prompt: string;
  devinMode?: string;
  abortSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
  extraBody?: Record<string, unknown>;
}

export interface SessionRequestArgs {
  baseURL: string;
  orgId: string;
  apiKey: string;
  devinId: string;
  abortSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ListMessagesArgs extends SessionRequestArgs {
  after?: string;
  first?: number;
}

function defaultFetch(): typeof fetch {
  return globalThis.fetch;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function throwOnError(
  response: Response,
  requestBodyValues: unknown,
): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    throw new APICallError({
      message: `Devin API error ${response.status}: ${text}`,
      url: response.url,
      requestBodyValues,
      statusCode: response.status,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      responseBody: text,
      isRetryable: response.status >= 500 || response.status === 429,
    });
  }
}

export async function createSession(
  args: CreateSessionArgs,
): Promise<DevinSessionResponse> {
  const fetchImpl = args.fetchImpl ?? defaultFetch();
  const body: Record<string, unknown> = { prompt: args.prompt };
  if (args.devinMode) {
    body.devin_mode = args.devinMode;
  }
  if (args.extraBody) {
    Object.assign(body, args.extraBody);
  }

  const response = await fetchImpl(
    `${args.baseURL}/organizations/${encodeURIComponent(args.orgId)}/sessions`,
    {
      method: "POST",
      headers: authHeaders(args.apiKey),
      body: JSON.stringify(body),
      signal: args.abortSignal,
    },
  );

  await throwOnError(response, body);
  return (await response.json()) as DevinSessionResponse;
}

export async function getSession(
  args: SessionRequestArgs,
): Promise<DevinSessionResponse> {
  const fetchImpl = args.fetchImpl ?? defaultFetch();
  const response = await fetchImpl(
    `${args.baseURL}/organizations/${encodeURIComponent(
      args.orgId,
    )}/sessions/${encodeURIComponent(args.devinId)}`,
    {
      method: "GET",
      headers: authHeaders(args.apiKey),
      signal: args.abortSignal,
    },
  );

  await throwOnError(response, undefined);
  return (await response.json()) as DevinSessionResponse;
}

export async function listMessages(
  args: ListMessagesArgs,
): Promise<DevinPaginatedResponse<DevinSessionMessage>> {
  const fetchImpl = args.fetchImpl ?? defaultFetch();
  const params = new URLSearchParams();
  if (args.first !== undefined) params.set("first", String(args.first));
  if (args.after !== undefined) params.set("after", args.after);
  const query = params.toString();

  const url =
    `${args.baseURL}/organizations/${encodeURIComponent(
      args.orgId,
    )}/sessions/${encodeURIComponent(args.devinId)}/messages` +
    (query ? `?${query}` : "");

  const response = await fetchImpl(url, {
    method: "GET",
    headers: authHeaders(args.apiKey),
    signal: args.abortSignal,
  });

  await throwOnError(response, undefined);
  return (await response.json()) as DevinPaginatedResponse<DevinSessionMessage>;
}
