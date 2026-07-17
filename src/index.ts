import type { Plugin, Hooks, Config, PluginInput } from "@opencode-ai/plugin";
import type { Model, Auth } from "@opencode-ai/sdk/v2";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchDevinModels } from "./discovery.js";

/**
 * Resolve the file:// URL for the `./devin.ts` entry point.
 * OpenCode's provider loader checks for `file://` prefix and imports directly,
 * bypassing `Npm.add()` (which would fail for unpublished local packages).
 */
const DEVIN_PROVIDER_NPM = (() => {
  const here = new URL(import.meta.url);
  const devinPath = path.resolve(path.dirname(here.pathname.replace(/^\//, "")), "devin.ts");
  return pathToFileURL(devinPath).href;
})();

const DEVIN_CASCADE_URL = "https://server.codeium.com";

// Static fallback models (used when dynamic discovery fails)
const FALLBACK_MODELS: Record<string, { name: string; reasoning?: boolean }> = {
  "swe-1-7": { name: "SWE-1-7", reasoning: true },
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

async function loadDevinApiKey(): Promise<string | undefined> {
  // Try OpenCode auth store first
  try {
    const raw = await readFile(authPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isObjectRecord(parsed)) {
      const devinAuth = parsed.devin;
      if (isObjectRecord(devinAuth)) {
        const key = typeof devinAuth.key === "string" ? devinAuth.key : undefined;
        if (key) return key;
      }
    }
  } catch {
    // No auth file yet
  }
  // Fall back to env var
  return process.env.DEVIN_API_KEY;
}

function extractApiKeyFromAuth(auth: Auth | undefined): string | undefined {
  if (!auth) return undefined;
  if (auth.type === "api") return auth.key;
  if (auth.type === "wellknown") return auth.key;
  return undefined;
}

function buildModel(
  modelId: string,
  name: string,
  opts: { reasoning: boolean; supportsImages: boolean; contextWindow: number; maxTokens: number },
): Model {
  return {
    id: modelId,
    providerID: "devin",
    api: {
      id: modelId,
      url: DEVIN_CASCADE_URL,
      npm: DEVIN_PROVIDER_NPM,
    },
    name,
    capabilities: {
      temperature: true,
      reasoning: opts.reasoning,
      attachment: opts.supportsImages,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: opts.supportsImages,
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
      context: opts.contextWindow,
      output: opts.maxTokens,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
  };
}

function buildFallbackModels(): Record<string, Model> {
  const models: Record<string, Model> = {};
  for (const [id, info] of Object.entries(FALLBACK_MODELS)) {
    models[id] = buildModel(id, info.name, {
      reasoning: info.reasoning ?? false,
      supportsImages: false,
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  }
  return models;
}

const devinPlugin: Plugin = async (_input: PluginInput) => {
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
        const apiKey =
          extractApiKeyFromAuth(ctx.auth) ??
          (await loadDevinApiKey()) ??
          process.env.DEVIN_API_KEY;

        if (!apiKey) {
          return buildFallbackModels();
        }

        const discovered = await fetchDevinModels({ apiKey });
        if (!discovered || discovered.length === 0) {
          return buildFallbackModels();
        }

        const models: Record<string, Model> = {};
        for (const m of discovered) {
          models[m.id] = buildModel(m.id, m.name, {
            reasoning: m.reasoning,
            supportsImages: m.supportsImages,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
          });
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
          npm: DEVIN_PROVIDER_NPM,
          name: "Devin",
          options: {},
          models: {},
        };
      } else {
        if (!cfg.provider.devin.npm || cfg.provider.devin.npm === "opencode-devin-provider/devin") {
          cfg.provider.devin.npm = DEVIN_PROVIDER_NPM;
        }
        if (!cfg.provider.devin.name) {
          cfg.provider.devin.name = "Devin";
        }
      }

      // Pull credentials from OpenCode's auth store or env, inject into provider options
      try {
        const apiKey = await loadDevinApiKey();
        if (apiKey) {
          cfg.provider.devin.options = cfg.provider.devin.options ?? {};
          if (!cfg.provider.devin.options.apiKey) {
            cfg.provider.devin.options.apiKey = apiKey;
          }
        }
      } catch {
        // Env vars or manually configured options will still work.
      }
    },
  };

  return hooks;
};

export default devinPlugin;
