/**
 * Provider-level settings for Devin.
 */
export interface DevinProviderSettings {
  /**
   * Devin service-user API key (prefix `cog_`).
   * Falls back to `DEVIN_API_KEY` env var.
   */
  apiKey?: string;
  /**
   * Devin organization ID (prefix `org-`).
   * Falls back to `DEVIN_ORG_ID` env var.
   */
  orgId?: string;
  /**
   * Devin API base URL. Defaults to `https://api.devin.ai/v3`.
   */
  baseURL?: string;
  /**
   * Additional headers to send with every request.
   */
  headers?: Record<string, string | undefined>;
  /**
   * Poll interval in milliseconds. Defaults to 5000.
   */
  pollIntervalMs?: number;
  /**
   * Maximum number of polls before giving up. Defaults to 360.
   */
  maxPolls?: number;
  /**
   * Custom fetch implementation. Useful for tests.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Per-model settings for Devin.
 */
export interface DevinModelSettings {
  /**
   * Devin agent mode for this model. Overrides any model-id mapping.
   */
  devinMode?: DevinMode;
}

export type DevinMode =
  | "normal"
  | "fast"
  | "lite"
  | "ultra"
  | "fusion";

export interface DevinProvider {
  /**
   * Return a Devin language model for the given model id.
   */
  (modelId: string, settings?: DevinModelSettings): {
    specificationVersion: "v1";
    provider: string;
    modelId: string;
    defaultObjectGenerationMode: undefined;
    doGenerate: any;
    doStream: any;
  };
}
