import type { Plugin, Hooks, Config } from "@opencode-ai/plugin";
import { loadDevinCredentials } from "./auth.js";

const DEFAULT_MODELS: Record<string, { name: string }> = {
  devin: { name: "Devin" },
  "devin-fast": { name: "Devin Fast" },
  "devin-lite": { name: "Devin Lite" },
  "devin-ultra": { name: "Devin Ultra" },
  "devin-fusion": { name: "Devin Fusion" },
};

const devinPlugin: Plugin = async () => {
  const hooks: Hooks = {
    auth: {
      provider: "devin",
      methods: [
        {
          type: "api",
          label: "Devin Service User",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: "Enter your Devin service-user API key (cog_...)",
              validate: (value) =>
                value?.startsWith("cog_")
                  ? undefined
                  : "API key must start with cog_",
            },
            {
              type: "text",
              key: "orgId",
              message: "Enter your Devin organization ID (org_...)",
              validate: (value) =>
                value?.startsWith("org-")
                  ? undefined
                  : "Org ID must start with org-",
            },
          ],
          async authorize(inputs) {
            return {
              type: "success",
              key: inputs?.apiKey ?? "",
              metadata: { orgId: inputs?.orgId ?? "" },
            };
          },
        },
      ],
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
          models: { ...DEFAULT_MODELS },
        };
      } else {
        // Ensure models are registered if the user provided a partial config.
        cfg.provider.devin.models = {
          ...DEFAULT_MODELS,
          ...cfg.provider.devin.models,
        };
        // Keep user-defined npm unless they left it blank.
        if (!cfg.provider.devin.npm) {
          cfg.provider.devin.npm = "opencode-devin-provider/devin";
        }
      }

      // Try to pull credentials from OpenCode's auth store so the user doesn't
      // have to duplicate them in opencode.json.
      try {
        const credentials = await loadDevinCredentials();
        if (credentials) {
          cfg.provider.devin.options = cfg.provider.devin.options ?? {};
          if (credentials.apiKey) {
            cfg.provider.devin.options.apiKey = credentials.apiKey;
          }
          if (credentials.orgId) {
            cfg.provider.devin.options.orgId = credentials.orgId;
          }
        }
      } catch {
        // If reading auth.json fails, env vars or manually configured options
        // will still work.
      }
    },
  };

  return hooks;
};

export default devinPlugin;
