import type { Plugin, Hooks, Config } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchDevinModels } from "./discovery.js";

const DEVIN_CALLBACK_PORT = 59653;

// Static fallback models (used when dynamic discovery fails)
const FALLBACK_MODELS: Record<string, { name: string; reasoning?: boolean }> = {
  "swe-1-6": { name: "SWE-1-6", reasoning: true },
  "gpt-5-6-sol": { name: "GPT-5.6 Sol", reasoning: true },
  "gpt-5-6-luna": { name: "GPT-5.6 Luna", reasoning: true },
  "gpt-5-6-terra": { name: "GPT-5.6 Terra", reasoning: true },
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function openCodeDataDir(): string {
  const home = os.homedir();
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(process.env.APPDATA ?? home, "opencode");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "opencode");
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "opencode");
  return path.join(home, ".local", "share", "opencode");
}

function authPath(): string {
  return path.join(openCodeDataDir(), "auth.json");
}

interface StoredCredentials {
  apiKey: string;
}

async function loadDevinCredentials(): Promise<StoredCredentials | undefined> {
  try {
    const raw = await readFile(authPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) return undefined;
    const devinAuth = parsed.devin;
    if (!isObjectRecord(devinAuth)) return undefined;
    const apiKey = typeof devinAuth.key === "string" ? devinAuth.key : undefined;
    if (!apiKey) return undefined;
    return { apiKey };
  } catch {
    return undefined;
  }
}

const devinPlugin: Plugin = async () => {
  const hooks: Hooks = {
    auth: {
      provider: "devin",
      methods: [
        {
          type: "api",
          label: "Devin CLI Token",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message:
                "Enter your Devin CLI session token.\nYou can get one by running `devin login` in a terminal, or paste a token from app.devin.ai.",
              placeholder: "Paste your Devin CLI token here...",
            },
          ],
          async authorize(inputs) {
            const key = inputs?.apiKey ?? "";
            if (!key) return { type: "failed" as const };
            return {
              type: "success" as const,
              key,
              provider: "devin",
            };
          },
        },
      ],
    },

    provider: {
      id: "devin",
      async models(_provider, ctx) {
        const credentials = await loadDevinCredentials();
        const apiKey =
          credentials?.apiKey ??
          process.env.DEVIN_API_KEY ??
          (ctx.auth as any)?.key;

        if (!apiKey) {
          // Return fallback models without discovery
          return buildFallbackModels();
        }

        const discovered = await fetchDevinModels({ apiKey });
        if (!discovered || discovered.length === 0) {
          return buildFallbackModels();
        }

        const models: Record<string, any> = {};
        for (const m of discovered) {
          models[m.id] = {
            id: m.id,
            name: m.name,
            api: {
              id: m.id,
              url: "https://server.codeium.com",
              npm: "opencode-devin-provider/devin",
            },
            capabilities: {
              temperature: true,
              reasoning: m.reasoning,
              attachment: m.supportsImages,
              toolcall: true,
              input: {
                text: true,
                audio: false,
                image: m.supportsImages,
                video: false,
                pdf: false,
              },
              output: {
                text: true,
                audio: false,
                image: false,
                video: false,
                pdf: false,
              },
              interleaved: false,
            },
            cost: {
              input: 0,
              output: 0,
              cache: { read: 0, write: 0 },
            },
            limit: {
              context: m.contextWindow,
              output: m.maxTokens,
            },
            status: "active" as const,
          };
        }
        return models;
      },
    },

    config: async (config) => {
      const cfg = config as Config & {
        provider?: Record<
          string,
          {
            npm?: string;
            name?: string;
            options?: Record<string, unknown>;
            models?: Record<string, unknown>;
          }
        >;
      };

      cfg.provider = cfg.provider ?? {};

      if (!cfg.provider.devin) {
        cfg.provider.devin = {
          npm: "opencode-devin-provider/devin",
          name: "Devin",
          options: {},
          models: {},
        };
      } else {
        if (!cfg.provider.devin.npm) {
          cfg.provider.devin.npm = "opencode-devin-provider/devin";
        }
        if (!cfg.provider.devin.name) {
          cfg.provider.devin.name = "Devin";
        }
      }

      // Pull credentials from OpenCode's auth store
      try {
        const credentials = await loadDevinCredentials();
        if (credentials?.apiKey) {
          cfg.provider.devin.options = cfg.provider.devin.options ?? {};
          cfg.provider.devin.options.apiKey = credentials.apiKey;
        }
      } catch {
        // Env vars or manually configured options will still work.
      }
    },
  };

  return hooks;
};

function buildFallbackModels(): Record<string, any> {
  const models: Record<string, any> = {};
  for (const [id, info] of Object.entries(FALLBACK_MODELS)) {
    models[id] = {
      id,
      name: info.name,
      api: {
        id,
        url: "https://server.codeium.com",
        npm: "opencode-devin-provider/devin",
      },
      capabilities: {
        temperature: true,
        reasoning: info.reasoning ?? false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 200_000, output: 64_000 },
      status: "active" as const,
    };
  }
  return models;
}

export default devinPlugin;
