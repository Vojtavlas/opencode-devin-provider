import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ChatMessageRequestType,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
} from "./devin-gen/exa/api_server_pb/api_server_pb";
import {
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
} from "./devin-gen/exa/auth_pb/auth_pb";
import {
  CacheControlType,
  type ChatMessagePrompt,
  ChatMessagePromptSchema,
  ChatToolChoiceSchema,
  ChatToolDefinitionSchema,
  PromptCacheOptionsSchema,
} from "./devin-gen/exa/chat_pb/chat_pb";
import {
  ChatMessageSource,
  type ChatToolCall,
  ChatToolCallSchema,
  CompletionConfigurationSchema,
  ConversationalPlannerMode,
  ImageDataSchema,
  MetadataSchema,
  StopReason,
} from "./devin-gen/exa/codeium_common_pb/codeium_common_pb";
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1FinishReason,
  LanguageModelV1StreamPart,
  LanguageModelV1Prompt,
  LanguageModelV1TextPart,
  LanguageModelV1ImagePart,
  LanguageModelV1FilePart,
  LanguageModelV1ToolCallPart,
  LanguageModelV1ToolResultPart,
} from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";

/** Base host for Codeium/Windsurf's Cascade chat API (Connect protocol over HTTP/1.1). */
export const DEVIN_CASCADE_URL = "https://server.codeium.com";

const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const DEVIN_IDE_VERSION = "3.2.23";
const DEVIN_EXTENSION_VERSION = "1.48.2";
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const DEVIN_DEFAULT_STOP_PATTERNS = ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];

const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

export interface DevinCascadeSettings {
  /** Devin CLI session token (obtained via `devin login` or OAuth). */
  apiKey?: string;
  /** Codeium/Windsurf Cascade API base URL. Defaults to `https://server.codeium.com`. */
  baseURL?: string;
  /** Additional headers to send with every request. */
  headers?: Record<string, string | undefined>;
  /** Custom fetch implementation. Useful for tests. */
  fetchImpl?: typeof fetch;
}

export interface DevinCascadeModelSettings {
  /** Wire model UID selected after thinking-effort routing. */
  chatModelUid?: string;
  /** Cascade conversation id; reused so the server threads turns. */
  conversationId?: string;
}

function normalizeDevinSessionToken(apiKey: string | undefined): string {
  if (!apiKey) return "";
  return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

interface DevinAuthMetadata {
  userJwt: string;
  baseUrl?: string;
}

async function fetchDevinAuthMetadata(
  apiKey: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<DevinAuthMetadata> {
  const request = create(GetUserJwtRequestSchema, {
    metadata: create(MetadataSchema, {
      apiKey,
      ideName: "windsurf",
      ideVersion: DEVIN_IDE_VERSION,
      extensionName: "windsurf",
      extensionVersion: DEVIN_EXTENSION_VERSION,
      locale: "en",
    }),
  });
  const response = await fetchImpl(`${baseUrl}${DEVIN_AUTH_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: toBinary(GetUserJwtRequestSchema, request),
    signal,
  });
  const payload = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new APICallError({
      message: `Devin auth error ${response.status} ${response.statusText}: ${new TextDecoder().decode(payload)}`,
      url: `${baseUrl}${DEVIN_AUTH_PATH}`,
      requestBodyValues: undefined,
      statusCode: response.status,
      isRetryable: response.status >= 500,
    });
  }
  const decoded = decodeDevinUserJwtResponse(payload);
  if (!decoded.userJwt) {
    throw new APICallError({
      message: "Devin auth error: GetUserJwt returned an empty user JWT",
      url: `${baseUrl}${DEVIN_AUTH_PATH}`,
      requestBodyValues: undefined,
      isRetryable: false,
    });
  }
  const customBaseUrl = decoded.customApiServerUrl.trim();
  return {
    userJwt: decoded.userJwt,
    ...(customBaseUrl ? { baseUrl: customBaseUrl.replace(/\/+$/, "") } : undefined),
  };
}

function decodeDevinUserJwtResponse(payload: Uint8Array) {
  try {
    return fromBinary(GetUserJwtResponseSchema, payload);
  } catch {
    return fromBinary(GetUserJwtResponseSchema, gunzipSync(payload));
  }
}

function stringifyUserPart(
  part: LanguageModelV1TextPart | LanguageModelV1ImagePart | LanguageModelV1FilePart,
): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      return "[image]";
    case "file":
      return `[file: ${part.mimeType}]`;
    default:
      return "";
  }
}

function stringifyAssistantPart(
  part:
    | LanguageModelV1TextPart
    | LanguageModelV1FilePart
    | LanguageModelV1ToolCallPart
    | { type: "reasoning"; text?: string }
    | { type: "redacted-reasoning"; data: string },
): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "file":
      return `[file: ${(part as LanguageModelV1FilePart).mimeType}]`;
    case "tool-call":
      return `[tool-call: ${part.toolName}(${JSON.stringify(part.args)})]`;
    case "reasoning":
      return "[reasoning]";
    case "redacted-reasoning":
      return "[redacted-reasoning]";
    default:
      return "";
  }
}

function stringifyToolPart(part: LanguageModelV1ToolResultPart): string {
  return `[tool-result: ${part.toolName} = ${JSON.stringify(part.result)}]`;
}

function renderSystemPrompt(prompt: LanguageModelV1Prompt): string {
  const lines: string[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      lines.push(message.content);
    }
  }
  return lines.join("\n\n");
}

function buildChatMessagePrompts(
  prompt: LanguageModelV1Prompt,
  cascadeId: string,
): ChatMessagePrompt[] {
  const prompts: ChatMessagePrompt[] = [];
  for (const [index, msg] of prompt.entries()) {
    if (msg.role === "user") {
      let promptText = "";
      const images: ReturnType<typeof create<typeof ImageDataSchema>>[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          promptText += part.text;
        } else if (part.type === "image") {
          images.push(
            create(ImageDataSchema, {
              base64Data: part.image instanceof Uint8Array ? Buffer.from(part.image).toString("base64") : "",
              mimeType: part.mimeType ?? "image/png",
            }),
          );
        }
      }
      prompts.push(
        create(ChatMessagePromptSchema, {
          messageId: deterministicUuid(`${cascadeId}\0${index}\0user`),
          source: ChatMessageSource.USER,
          prompt: promptText,
          images: images as any,
        }),
      );
    } else if (msg.role === "assistant") {
      let promptText = "";
      let thinkingText = "";
      let signature = "";
      const toolCalls: ChatToolCall[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          promptText += part.text;
        } else if (part.type === "tool-call") {
          toolCalls.push(
            create(ChatToolCallSchema, {
              id: part.toolCallId,
              name: part.toolName,
              argumentsJson: JSON.stringify(part.args),
            }),
          );
        }
      }
      prompts.push(
        create(ChatMessagePromptSchema, {
          messageId: `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
          source: ChatMessageSource.SYSTEM,
          prompt: promptText,
          thinking: thinkingText,
          signature,
          signatureType: "",
          toolCalls,
        }),
      );
    } else if (msg.role === "tool") {
      let resultText = "";
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          resultText += JSON.stringify(part.result);
        }
      }
      prompts.push(
        create(ChatMessagePromptSchema, {
          messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${msg.content[0]?.toolCallId ?? ""}`),
          source: ChatMessageSource.TOOL,
          toolCallId: msg.content[0]?.toolCallId ?? "",
          toolResultIsError: msg.content[0]?.isError ?? false,
          prompt: resultText,
        }),
      );
    }
  }
  return prompts;
}

function deterministicUuid(seed: string): string {
  const hash = Buffer.from(seed).toString("base64url").slice(0, 22);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function buildDevinChatRequest(
  modelId: string,
  chatModelUid: string | undefined,
  prompt: LanguageModelV1Prompt,
  options: LanguageModelV1CallOptions,
  apiKey: string,
  userJwt: string,
  conversationId?: string,
) {
  const cascadeId = conversationId ?? crypto.randomUUID();
  const stopPatterns =
    options.stopSequences && options.stopSequences.length > 0
      ? [...DEVIN_DEFAULT_STOP_PATTERNS, ...options.stopSequences]
      : DEVIN_DEFAULT_STOP_PATTERNS;

  const tools = options.mode?.type === "regular" && options.mode.tools
    ? options.mode.tools
        .filter((t): t is { type: "function"; name: string; description?: string; parameters: any } => t.type === "function")
        .map((tool) =>
          create(ChatToolDefinitionSchema, {
            name: tool.name,
            description: tool.description ?? "",
            jsonSchemaString: JSON.stringify(tool.parameters),
            strict: false,
          }),
        )
    : [];

  return create(GetChatMessageRequestSchema, {
    metadata: create(MetadataSchema, {
      apiKey,
      userJwt,
      ideName: "windsurf",
      ideVersion: DEVIN_IDE_VERSION,
      extensionName: "windsurf",
      extensionVersion: DEVIN_EXTENSION_VERSION,
      locale: "en",
    }),
    prompt: renderSystemPrompt(prompt),
    chatMessagePrompts: buildChatMessagePrompts(prompt, cascadeId),
    chatModelUid: chatModelUid ?? modelId,
    requestType: ChatMessageRequestType.CASCADE,
    plannerMode: ConversationalPlannerMode.DEFAULT,
    toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
    systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
    disableParallelToolCalls: true,
    cascadeId,
    executionId: crypto.randomUUID(),
    configuration: create(CompletionConfigurationSchema, {
      numCompletions: 1n,
      maxTokens: BigInt(options.maxTokens ?? 64000),
      maxNewlines: 200n,
      temperature: options.temperature ?? 0.4,
      firstTemperature: options.temperature ?? 0.4,
      topK: 50n,
      topP: options.topP ?? 1,
      stopPatterns,
      fimEotProbThreshold: 1,
    }),
    tools,
  });
}

function readConnectTrailerError(text: string): string | null {
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
  const err = (parsed as any).error;
  if (!err || typeof err !== "object") return null;
  const code = "code" in err && typeof err.code === "string" ? err.code : "";
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  if (!code && !message) return null;
  return `Devin stream error${code ? ` ${code}` : ""}: ${message}`;
}

class DevinCascadeLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = "v1" as const;
  readonly provider = "devin";
  readonly modelId: string;
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;
  readonly supportsStructuredOutputs = false;

  private readonly settings: DevinCascadeSettings;
  private readonly modelSettings: DevinCascadeModelSettings;

  constructor(
    modelId: string,
    settings: DevinCascadeSettings,
    modelSettings: DevinCascadeModelSettings = {},
  ) {
    this.modelId = modelId;
    this.settings = settings;
    this.modelSettings = modelSettings;
  }

  async doGenerate(options: LanguageModelV1CallOptions): Promise<any> {
    const { stream } = await this.doStream(options);
    let text = "";
    let finishReason: LanguageModelV1FinishReason = "stop";
    let usage = { promptTokens: 0, completionTokens: 0 };
    const toolCalls: any[] = [];

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "text-delta") {
          text += value.textDelta;
        } else if (value.type === "tool-call") {
          toolCalls.push(value);
        } else if (value.type === "finish") {
          finishReason = value.finishReason;
          usage = value.usage;
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage,
      rawCall: { rawPrompt: options.prompt, rawSettings: {} },
    };
  }

  async doStream(
    options: LanguageModelV1CallOptions,
  ): Promise<{ stream: ReadableStream<LanguageModelV1StreamPart>; rawCall: any }> {
    const fetchImpl = this.settings.fetchImpl ?? fetch;
    const baseUrl = (this.settings.baseURL ?? DEVIN_CASCADE_URL).replace(/\/+$/, "");

    const providerApiKey = options.providerMetadata?.devin?.apiKey;
    const apiKey = normalizeDevinSessionToken(
      this.settings.apiKey ??
        (typeof providerApiKey === "string" ? providerApiKey : undefined) ??
        process.env.DEVIN_API_KEY,
    );

    if (!apiKey) {
      throw new APICallError({
        message: "Devin API key is required. Set DEVIN_API_KEY or configure the provider.",
        url: baseUrl,
        requestBodyValues: undefined,
        isRetryable: false,
      });
    }

    const auth = await fetchDevinAuthMetadata(apiKey, baseUrl, fetchImpl, options.abortSignal);
    const chatBaseUrl = auth.baseUrl ?? baseUrl;
    const request = buildDevinChatRequest(
      this.modelId,
      this.modelSettings.chatModelUid,
      options.prompt,
      options,
      apiKey,
      auth.userJwt,
      this.modelSettings.conversationId,
    );

    const reqBytes = toBinary(GetChatMessageRequestSchema, request);
    const gz = gzipSync(reqBytes);
    const frame = Buffer.alloc(5 + gz.length);
    frame[0] = CONNECT_COMPRESSED_FLAG;
    frame.writeUInt32BE(gz.length, 1);
    frame.set(gz, 5);

    const response = await fetchImpl(chatBaseUrl + CHAT_MESSAGE_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/connect+proto",
        "connect-protocol-version": "1",
        "connect-content-encoding": "gzip",
        "accept-encoding": "identity",
        "user-agent": "connect-go/1.18.1 (go1.26.3)",
        "connect-accept-encoding": "gzip",
        ...(this.settings.headers ?? {}),
      },
      body: frame,
      signal: options.abortSignal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new APICallError({
        message: `Devin API error ${response.status} ${response.statusText}: ${text}`,
        url: chatBaseUrl + CHAT_MESSAGE_PATH,
        requestBodyValues: undefined,
        statusCode: response.status,
        isRetryable: response.status >= 500 || response.status === 429,
      });
    }
    if (!response.body) {
      throw new APICallError({
        message: "Devin API error: response body is empty",
        url: chatBaseUrl + CHAT_MESSAGE_PATH,
        requestBodyValues: undefined,
        isRetryable: false,
      });
    }

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      async start(controller) {
        try {
          controller.enqueue({
            type: "response-metadata",
          });

          const reader = response.body!.getReader();
          let pending = Buffer.alloc(0);

          // Tool-call tracking
          const toolBlocks = new Map<string, { id: string; name: string; args: string }>();
          const toolPartialJson = new Map<string, string>();
          let activeToolCallId: string | undefined;
          let latestStopReason = StopReason.UNSPECIFIED;
          let usage = { promptTokens: 0, completionTokens: 0 };
          let responseId: string | undefined;

          for (;;) {
            const { done, value } = await reader.read();
            if (value && value.length > 0) {
              pending = Buffer.concat([pending, value]);
            }

            while (pending.length >= 5) {
              const flag = pending[0];
              const len = pending.readUInt32BE(1);
              if (len > MAX_CONNECT_FRAME_PAYLOAD) {
                throw new Error(`Devin Connect frame length ${len} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`);
              }
              if (pending.length < 5 + len) break;
              const payload = pending.subarray(5, 5 + len);
              pending = pending.subarray(5 + len);

              if (flag & CONNECT_END_STREAM_FLAG) {
                const trailerBytes = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
                const trailerError = readConnectTrailerError(trailerBytes.toString("utf8").trim());
                if (trailerError) throw new Error(trailerError);
                continue;
              }

              const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
              const msg = fromBinary(GetChatMessageResponseSchema, raw);
              if (msg.messageId && !responseId) responseId = msg.messageId;

              if (msg.deltaThinking) {
                // Emit thinking as text-delta (AI SDK v1 doesn't have a dedicated thinking part)
                controller.enqueue({
                  type: "text-delta",
                  textDelta: msg.deltaThinking,
                });
              }

              if (msg.deltaText) {
                controller.enqueue({
                  type: "text-delta",
                  textDelta: msg.deltaText,
                });
              }

              if (msg.deltaToolCalls.length > 0) {
                for (const tc of msg.deltaToolCalls) {
                  const toolCallId = tc.id || activeToolCallId;
                  if (!toolCallId) continue;
                  let block = toolBlocks.get(toolCallId);
                  if (!block) {
                    block = { id: toolCallId, name: tc.name, args: "" };
                    toolBlocks.set(toolCallId, block);
                    toolPartialJson.set(toolCallId, "");
                  }
                  if (tc.name) block.name = tc.name;
                  activeToolCallId = toolCallId;
                  if (!tc.argumentsJson) continue;
                  const previousJson = toolPartialJson.get(toolCallId) ?? "";
                  const accumulated = tc.argumentsJson.startsWith(previousJson)
                    ? tc.argumentsJson
                    : previousJson + tc.argumentsJson;
                  toolPartialJson.set(toolCallId, accumulated);
                  block.args = accumulated;
                }
              }

              if (msg.stopReason !== StopReason.UNSPECIFIED) {
                latestStopReason = msg.stopReason;
              }

              if (msg.usage) {
                usage = {
                  promptTokens: Number(msg.usage.inputTokens),
                  completionTokens: Number(msg.usage.outputTokens),
                };
              }
            }

            if (done) break;
          }

          // Emit finalized tool calls
          for (const [, block] of toolBlocks) {
            let parsedArgs: unknown;
            try {
              parsedArgs = JSON.parse(block.args);
            } catch {
              parsedArgs = block.args;
            }
            controller.enqueue({
              type: "tool-call",
              toolCallType: "function",
              toolCallId: block.id,
              toolName: block.name,
              args: JSON.stringify(parsedArgs),
            });
          }

          const finishReason: LanguageModelV1FinishReason =
            toolBlocks.size > 0
              ? "tool-calls"
              : latestStopReason === StopReason.MAX_TOKENS
                ? "length"
                : "stop";

          controller.enqueue({
            type: "finish",
            finishReason,
            usage,
          });
          controller.close();
        } catch (error) {
          const err =
            error instanceof Error
              ? error
              : new Error(`Devin provider stream error: ${String(error)}`);
          controller.enqueue({ type: "error", error: err });
          controller.close();
        }
      },
    });

    return {
      stream,
      rawCall: {
        rawPrompt: options.prompt,
        rawSettings: { chatModelUid: this.modelSettings.chatModelUid ?? this.modelId },
      },
    };
  }
}

/**
 * Create a configured Devin Cascade AI SDK provider.
 * Returns an object with a `languageModel(modelId)` method, matching the
 * shape OpenCode expects from a provider factory (like `createOpenAICompatible`).
 */
export function createDevinCascadeProvider(
  settings: DevinCascadeSettings = {},
): {
  languageModel(modelId: string, modelSettings?: DevinCascadeModelSettings): LanguageModelV1;
} {
  return {
    languageModel(modelId, modelSettings) {
      return new DevinCascadeLanguageModel(modelId, settings, modelSettings);
    },
  };
}

/**
 * Default Devin Cascade provider instance. Uses `DEVIN_API_KEY` env var.
 */
export const devin = createDevinCascadeProvider({});
