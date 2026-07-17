import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

  // Linux / other: prefer XDG_DATA_HOME, then ~/.local/share
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "opencode");
  return path.join(home, ".local", "share", "opencode");
}

function authPath(): string {
  return path.join(openCodeDataDir(), "auth.json");
}

export interface DevinCredentials {
  apiKey: string;
  orgId?: string;
}

export async function loadDevinCredentials(): Promise<DevinCredentials | undefined> {
  try {
    const raw = await readFile(authPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) return undefined;

    const devinAuth = parsed.devin;
    if (!isObjectRecord(devinAuth)) return undefined;

    const apiKey = typeof devinAuth.key === "string" ? devinAuth.key : undefined;
    if (!apiKey) return undefined;

    let orgId: string | undefined;
    const metadata = isObjectRecord(devinAuth.metadata)
      ? devinAuth.metadata
      : undefined;
    if (metadata && typeof metadata.orgId === "string") {
      orgId = metadata.orgId;
    }

    return { apiKey, orgId };
  } catch {
    return undefined;
  }
}
