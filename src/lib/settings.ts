import browser from "webextension-polyfill";
import type { StrixClipperSettings } from "../types/capture";

const SETTINGS_KEY = "strixClipperSettings";

export const DEFAULT_SETTINGS: StrixClipperSettings = {
  apiBaseUrl: "",
  apiToken: "",
  defaultDestination: "library"
};

export async function getSettings(): Promise<StrixClipperSettings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...((stored[SETTINGS_KEY] as Partial<StrixClipperSettings> | undefined) ?? {})
  };

  return {
    ...settings,
    defaultDestination: normalizeDestination(settings.defaultDestination)
  };
}

export async function saveSettings(
  settings: StrixClipperSettings
): Promise<StrixClipperSettings> {
  const normalized = {
    ...settings,
    apiBaseUrl: settings.apiBaseUrl.trim().replace(/\/+$/, ""),
    apiToken: settings.apiToken.trim(),
    defaultDestination: normalizeDestination(settings.defaultDestination)
  };

  await browser.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

export function isSyncConfigured(settings: StrixClipperSettings): boolean {
  return Boolean(settings.apiBaseUrl && settings.apiToken);
}

function normalizeDestination(
  destination: StrixClipperSettings["defaultDestination"] | string | undefined
): StrixClipperSettings["defaultDestination"] {
  return destination === "library" ? "library" : DEFAULT_SETTINGS.defaultDestination;
}
