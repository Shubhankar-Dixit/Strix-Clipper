import browser from "webextension-polyfill";
import type {
  ArticleCleanupMode,
  CaptureExtractionSettings,
  DefaultCaptureMode,
  StrixClipperSettings
} from "../types/capture";

const SETTINGS_KEY = "strixClipperSettings";

export const DEFAULT_SETTINGS: StrixClipperSettings = {
  apiBaseUrl: "",
  apiToken: "",
  defaultDestination: "library",
  defaultCaptureMode: "smart",
  articleCleanupMode: "smart",
  includeImages: true,
  includeReplies: false,
  preferredLanguage: ""
};

export async function getSettings(): Promise<StrixClipperSettings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...((stored[SETTINGS_KEY] as Partial<StrixClipperSettings> | undefined) ?? {})
  };

  return {
    ...settings,
    defaultDestination: normalizeDestination(settings.defaultDestination),
    defaultCaptureMode: normalizeDefaultCaptureMode(settings.defaultCaptureMode),
    articleCleanupMode: normalizeArticleCleanupMode(settings.articleCleanupMode),
    includeImages: settings.includeImages !== false,
    includeReplies: settings.includeReplies === true,
    preferredLanguage: normalizeLanguage(settings.preferredLanguage)
  };
}

export async function saveSettings(
  settings: StrixClipperSettings
): Promise<StrixClipperSettings> {
  const normalized = {
    ...settings,
    apiBaseUrl: settings.apiBaseUrl.trim().replace(/\/+$/, ""),
    apiToken: settings.apiToken.trim(),
    defaultDestination: normalizeDestination(settings.defaultDestination),
    defaultCaptureMode: normalizeDefaultCaptureMode(settings.defaultCaptureMode),
    articleCleanupMode: normalizeArticleCleanupMode(settings.articleCleanupMode),
    includeImages: settings.includeImages !== false,
    includeReplies: settings.includeReplies === true,
    preferredLanguage: normalizeLanguage(settings.preferredLanguage)
  };

  await browser.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

export function isSyncConfigured(settings: StrixClipperSettings): boolean {
  return Boolean(settings.apiBaseUrl && settings.apiToken);
}

export function extractionSettingsFrom(
  settings: StrixClipperSettings
): CaptureExtractionSettings {
  return {
    defaultCaptureMode: normalizeDefaultCaptureMode(settings.defaultCaptureMode),
    articleCleanupMode: normalizeArticleCleanupMode(settings.articleCleanupMode),
    includeImages: settings.includeImages !== false,
    includeReplies: settings.includeReplies === true,
    preferredLanguage: normalizeLanguage(settings.preferredLanguage)
  };
}

function normalizeDestination(
  destination: StrixClipperSettings["defaultDestination"] | string | undefined
): StrixClipperSettings["defaultDestination"] {
  return destination === "library" ? "library" : DEFAULT_SETTINGS.defaultDestination;
}

function normalizeDefaultCaptureMode(
  mode: DefaultCaptureMode | string | undefined
): DefaultCaptureMode {
  return mode === "page" || mode === "selection" || mode === "bookmark" || mode === "smart"
    ? mode
    : DEFAULT_SETTINGS.defaultCaptureMode;
}

function normalizeArticleCleanupMode(
  mode: ArticleCleanupMode | string | undefined
): ArticleCleanupMode {
  return mode === "reader" || mode === "loose" || mode === "smart"
    ? mode
    : DEFAULT_SETTINGS.articleCleanupMode;
}

function normalizeLanguage(language: string | undefined): string {
  return (language ?? "").trim().slice(0, 32);
}
