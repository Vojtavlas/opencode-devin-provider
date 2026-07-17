import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1FinishReason,
  LanguageModelV1StreamPart,
} from "@ai-sdk/provider";
import { APICallError, InvalidArgumentError } from "@ai-sdk/provider";
import { createSession, getSession, listMessages } from "./session.js";
import { renderPrompt } from "./messages.js";
import type { DevinModelSettings, DevinMode, DevinProviderSettings } from "./types.js";

export { type DevinProviderSettings, type DevinModelSettings } from "./types.js";

const DEFAULT_BASE_URL = "https://api.devin.ai/v3";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_POLLS = 360;

const TERMINAL_STATUSES = new Set(["exit", "error", "suspended"]);

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function devinModeFromModelId(modelId: string): DevinMode {
  if (modelId === "fast" || modelId.endsWith("-fast")) return "fast";
  if (modelId === "lite" || modelId.endsWith("-lite")) return "lite";
  if (modelId === "ultra" || modelId.endsWith("-ultra")) return "ultra";
  if (modelId === "fusion" || modelId.endsWith("-fusion")) return "fusion";
  return "normal";
}

function loadSetting(
  settingsValue: string | undefined,
  envName: string,
): string | undefined {
  return settingsValue ?? process.env[envName];
}

function resolveCredentials(
  settings: DevinProviderSettings,
  providerMetadata: unknown,
): { apiKey: string; orgId: string } {
  const metadata = isObjectRecord(providerMetadata)
    ? (providerMetadata as Record<string, unknown>)
    : undefined;

  const apiKey =
    metadata?.apiKey ?? settings.apiKey ?? loadSetting(undefined, "DEVIN_API_KEY");
  const orgId =
    metadata?.orgId ?? settings.orgId ?? loadSetting(undefined, "DEVIN_ORG_ID");

  if (typeof apiKey !== "string" || !apiKey) {
    throw new InvalidArgumentError({
      argument: "apiKey",
      message:
        "Devin API key is required. Set DEVIN_API_KEY, config.provider.devin.options.apiKey, or providerOptions.devin.apiKey.",
    });
  }
  if (typeof orgId !== "string" || !orgId) {
    throw new InvalidArgumentError({
      argument: "orgId",
      message:
        "Devin org ID is required. Set DEVIN_ORG_ID, config.provider.devin.options.orgId, or providerOptions.devin.orgId.",
    });
  }

  return { apiKey, orgId };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("AbortError"));
    });
  });
}

class DevinLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = "v1" as const;
  readonly provider = "opencode-devin-provider";
  readonly modelId: string;
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;
  readonly supportsStructuredOutputs = false;

  private readonly settings: DevinProviderSettings;
  private readonly modelSettings: DevinModelSettings;

  constructor(
    modelId: string,
    settings: DevinProviderSettings,
    modelSettings: DevinModelSettings = {},
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

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "text-delta") {
          text += value.textDelta;
        } else if (value.type === "finish") {
          finishReason = value.finishReason;
          usage = value.usage;
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      text,
      finishReason,
      usage,
      rawCall: { rawPrompt: options.prompt, rawSettings: {} },
    };
  }

  async doStream(
    options: LanguageModelV1CallOptions,
  ): Promise<{ stream: ReadableStream<LanguageModelV1StreamPart>; rawCall: any }> {
    const devinMetadata = options.providerMetadata?.["devin"];
    const { apiKey, orgId } = resolveCredentials(this.settings, devinMetadata);

    const baseURL = (this.settings.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const prompt = renderPrompt(options.prompt);

    const devinMode =
      this.modelSettings.devinMode ?? devinModeFromModelId(this.modelId);

    const settings = this.settings;

    const session = await createSession({
      baseURL,
      orgId,
      apiKey,
      prompt,
      devinMode,
      abortSignal: options.abortSignal,
      fetchImpl: settings.fetchImpl,
    });

    const devinId = session.session_id;
    const pollIntervalMs = settings.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxPolls = settings.maxPolls ?? DEFAULT_MAX_POLLS;

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      async start(controller) {
        try {
          controller.enqueue({
            type: "response-metadata",
            id: devinId,
          });

          const seenIds = new Set<string>();
          let pollCount = 0;

          while (true) {
            if (options.abortSignal?.aborted) {
              throw new Error("AbortError");
            }

            const [sessionDetails, messages] = await Promise.all([
              getSession({
                baseURL,
                orgId,
                apiKey,
                devinId,
                abortSignal: options.abortSignal,
                fetchImpl: settings.fetchImpl,
              }),
              listMessages({
                baseURL,
                orgId,
                apiKey,
                devinId,
                first: 100,
                abortSignal: options.abortSignal,
                fetchImpl: settings.fetchImpl,
              }),
            ]);

            for (const message of messages.items) {
              if (message.source === "devin" && !seenIds.has(message.event_id)) {
                seenIds.add(message.event_id);
                if (message.message) {
                  controller.enqueue({
                    type: "text-delta",
                    textDelta: message.message,
                  });
                }
              }
            }

            if (isTerminalStatus(sessionDetails.status)) {
              const finishReason: LanguageModelV1FinishReason =
                sessionDetails.status === "error" ? "error" : "stop";
              controller.enqueue({
                type: "finish",
                finishReason,
                usage: { promptTokens: 0, completionTokens: 0 },
              });
              controller.close();
              return;
            }

            pollCount += 1;
            if (pollCount > maxPolls) {
              throw new Error(
                `Devin session ${devinId} did not reach a terminal status within ${maxPolls} polls.`,
              );
            }

            await delay(pollIntervalMs, options.abortSignal);
          }
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
        rawPrompt: prompt,
        rawSettings: { devinMode },
      },
    };
  }
}

/**
 * Create a configured Devin AI SDK provider.
 */
export function createDevinProvider(
  settings: DevinProviderSettings = {},
): (modelId: string, modelSettings?: DevinModelSettings) => LanguageModelV1 {
  return (modelId, modelSettings) =>
    new DevinLanguageModel(modelId, settings, modelSettings);
}

/**
 * Default Devin provider instance. Uses `DEVIN_API_KEY` and `DEVIN_ORG_ID` env vars.
 */
export const devin = createDevinProvider({});
