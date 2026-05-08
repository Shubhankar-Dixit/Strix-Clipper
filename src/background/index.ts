import browser from "webextension-polyfill";
import type { BackgroundMessage } from "../lib/messages";
import { extractionSettingsFrom, getSettings, saveSettings } from "../lib/settings";
import {
  clearCaptures,
  createCapture,
  deleteCapture,
  getCapture,
  getCaptureStats,
  listCaptures,
  listCapturesForPage
} from "../lib/storage";
import { captureToMarkdown } from "../lib/markdown";
import { syncCaptures } from "../lib/strixApi";
import type { CaptureContext, CaptureDraft } from "../types/capture";

const ROOT_MENU_ID = "strix-root";
const SAVE_PAGE_MENU_ID = "strix-save-page";
const COPY_PAGE_MENU_ID = "strix-copy-page";
const SAVE_IMAGE_MENU_ID = "strix-save-image";
const ADD_HIGHLIGHT_MENU_ID = "strix-add-selection-highlight";
const CLIP_HIGHLIGHTS_MENU_ID = "strix-clip-highlights";
const START_HIGHLIGHT_MENU_ID = "strix-start-highlighter";
const STOP_HIGHLIGHT_MENU_ID = "strix-stop-highlighter";
const pendingRestores = new Map<
  number,
  Pick<CaptureContext, "scrollX" | "scrollY" | "textQuote" | "formState">
>();
let contextMenuSetup: Promise<unknown> = Promise.resolve();

browser.runtime.onInstalled.addListener(() => {
  queueContextMenuSetup();
});
browser.runtime.onStartup.addListener(() => {
  queueContextMenuSetup();
});
queueContextMenuSetup();

function queueContextMenuSetup(): void {
  contextMenuSetup = contextMenuSetup.then(setupContextMenus, setupContextMenus).catch(() => undefined);
}

async function setupContextMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  await browser.contextMenus.create({
    id: ROOT_MENU_ID,
    title: "Strix Clipper",
    contexts: ["page", "selection", "image"]
  });
  await browser.contextMenus.create({
    id: SAVE_PAGE_MENU_ID,
    parentId: ROOT_MENU_ID,
    title: "Save this page",
    contexts: ["page", "selection", "image"]
  });
  await browser.contextMenus.create({
    id: COPY_PAGE_MENU_ID,
    parentId: ROOT_MENU_ID,
    title: "Copy to clipboard",
    contexts: ["page", "selection"]
  });
  await browser.contextMenus.create({
    id: SAVE_IMAGE_MENU_ID,
    parentId: ROOT_MENU_ID,
    title: "Save image",
    contexts: ["image"]
  });
  await browser.contextMenus.create({
    id: ADD_HIGHLIGHT_MENU_ID,
    parentId: ROOT_MENU_ID,
    title: "Add to highlights",
    contexts: ["selection"]
  });
  await browser.contextMenus.create({
    id: CLIP_HIGHLIGHTS_MENU_ID,
    parentId: ROOT_MENU_ID,
    title: "Clip highlights",
    contexts: ["page", "selection"]
  });
  await browser.contextMenus.create({
    id: START_HIGHLIGHT_MENU_ID,
    parentId: ROOT_MENU_ID,
    title: "Start highlighter",
    contexts: ["page", "selection"]
  });
  await browser.contextMenus.create({
    id: STOP_HIGHLIGHT_MENU_ID,
    parentId: ROOT_MENU_ID,
    title: "Stop highlighter",
    contexts: ["page", "selection"]
  });
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) {
    return;
  }

  if (info.menuItemId === SAVE_PAGE_MENU_ID) {
    await savePageFromTab(tab.id).catch(() => undefined);
    return;
  }

  if (info.menuItemId === COPY_PAGE_MENU_ID) {
    await copyPageMarkdownFromTab(tab.id).catch(() => undefined);
    return;
  }

  if (info.menuItemId === ADD_HIGHLIGHT_MENU_ID) {
    await sendContentMessage(tab.id, { type: "strix:add-selection-highlight" }).catch(() => undefined);
    return;
  }

  if (info.menuItemId === CLIP_HIGHLIGHTS_MENU_ID) {
    await sendContentMessage(tab.id, { type: "strix:clip-page-highlights" }).catch(() => undefined);
    return;
  }

  if (info.menuItemId === START_HIGHLIGHT_MENU_ID) {
    await sendContentMessage(tab.id, { type: "strix:activate-highlight-mode" }).catch(() => undefined);
    return;
  }

  if (info.menuItemId === STOP_HIGHLIGHT_MENU_ID) {
    await sendContentMessage(tab.id, { type: "strix:deactivate-highlight-mode" }).catch(() => undefined);
    return;
  }

  if (info.menuItemId !== SAVE_IMAGE_MENU_ID || !info.srcUrl) {
    return;
  }

  const settings = await getSettings();
  const capturedAt = new Date().toISOString();
  const draft: CaptureDraft = {
    kind: "image",
    source: {
      url: info.pageUrl ?? tab?.url ?? info.srcUrl,
      title: tab?.title,
      capturedAt
    },
    content: {
      imageUrls: [info.srcUrl],
      markdown: `![Captured image](${info.srcUrl})`
    },
    context: {
      imageUrl: info.srcUrl
    },
    destination: {
      target: settings.defaultDestination
    }
  };

  await createCapture(draft);
});

async function savePageFromTab(tabId: number): Promise<void> {
  const settings = await getSettings();
  const draft = await sendContentMessage(tabId, {
    type: "strix:extract",
    kind: "smart",
    defaultDestination: settings.defaultDestination,
    extractionSettings: extractionSettingsFrom(settings)
  }) as CaptureDraft;

  await createCapture(draft);
  await sendContentMessage(tabId, {
    type: "strix:play-clip-feedback",
    kind: draft.kind
  }).catch(() => undefined);
}

async function copyPageMarkdownFromTab(tabId: number): Promise<void> {
  const settings = await getSettings();
  const draft = await sendContentMessage(tabId, {
    type: "strix:extract",
    kind: "smart",
    defaultDestination: settings.defaultDestination,
    extractionSettings: extractionSettingsFrom(settings)
  }) as CaptureDraft;
  const capture = await createCapture(draft);
  const markdown = captureToMarkdown(capture);
  const scriptingBrowser = browser as typeof browser & {
    scripting?: {
      executeScript(details: {
        target: { tabId: number };
        func: (value: string) => Promise<void>;
        args: string[];
      }): Promise<unknown[]>;
    };
  };

  await scriptingBrowser.scripting?.executeScript({
    target: { tabId },
    args: [markdown],
    func: async (value: string) => {
      await navigator.clipboard.writeText(value);
    }
  });
  await sendContentMessage(tabId, {
    type: "strix:play-clip-feedback",
    kind: capture.kind
  }).catch(() => undefined);
}

function isMissingContentScriptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Receiving end does not exist") || message.includes("Could not establish connection");
}

async function injectContentScript(tabId: number): Promise<void> {
  const scriptingBrowser = browser as typeof browser & {
    scripting?: {
      executeScript(details: { target: { tabId: number }; files: string[] }): Promise<unknown[]>;
    };
  };

  await scriptingBrowser.scripting?.executeScript({
    target: { tabId },
    files: ["assets/content.js"]
  });
}

async function sendContentMessage(tabId: number, message: unknown): Promise<unknown> {
  try {
    return await browser.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingContentScriptError(error)) {
      throw error;
    }

    await injectContentScript(tabId);
    return browser.tabs.sendMessage(tabId, message);
  }
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const request = message as BackgroundMessage;

  switch (request.type) {
    case "captures:create":
      return createCapture(request.draft).then((capture) => ({ capture }));
    case "captures:delete":
      return deleteCapture(request.captureId).then(() => ({ ok: true }));
    case "captures:list":
      return listCaptures(request.limit).then((captures) => ({ captures }));
    case "captures:for-url":
      return listCapturesForPage(request.url, request.canonicalUrl).then((captures) => ({
        captures
      }));
    case "captures:stats":
      return getCaptureStats().then((stats) => ({ stats }));
    case "captures:sync":
      return getSettings().then(syncCaptures);
    case "captures:open":
      return openCapture(request.captureId).then(() => ({ ok: true }));
    case "captures:clear":
      return clearCaptures().then(async () => {
        pendingRestores.clear();
        await refreshHighlightsInOpenTabs();
        return { ok: true };
      });
    case "settings:get":
      return getSettings().then((settings) => ({ settings }));
    case "settings:set":
      return saveSettings(request.settings).then((settings) => ({ settings }));
    default:
      return undefined;
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  const restore = pendingRestores.get(tabId);
  if (!restore) {
    return;
  }

  pendingRestores.delete(tabId);
  browser.tabs.sendMessage(tabId, {
    type: "strix:restore-context",
    ...restore
  }).catch(() => undefined);
});

async function openCapture(captureId: string): Promise<void> {
  const capture = await getCapture(captureId);
  if (!capture) {
    throw new Error("Capture not found.");
  }

  const url =
    capture.kind === "page-state"
      ? capture.source.url
      : urlWithTextFragment(
          capture.source.url,
          capture.context.textFragment ?? capture.context.textQuote
        );
  const tab = await browser.tabs.create({ url });

  if (
    tab.id &&
    (capture.context.scrollX !== undefined ||
      capture.context.scrollY !== undefined ||
      capture.context.textQuote ||
      capture.context.formState)
  ) {
    pendingRestores.set(tab.id, {
      scrollX: capture.context.scrollX,
      scrollY: capture.context.scrollY,
      textQuote: capture.context.textQuote,
      formState: capture.context.formState
    });
  }
}

async function refreshHighlightsInOpenTabs(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => tab.id && tab.url && /^https?:\/\//.test(tab.url))
      .map((tab) =>
        browser.tabs.sendMessage(tab.id as number, {
          type: "strix:refresh-highlights"
        }).catch(() => undefined)
      )
  );
}

function urlWithTextFragment(url: string, text?: string): string {
  if (!text?.trim()) {
    return url;
  }

  try {
    const parsed = new URL(url);
    parsed.hash = `:~:text=${encodeURIComponent(text.trim())}`;
    return parsed.toString();
  } catch {
    return url;
  }
}
