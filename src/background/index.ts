import browser from "webextension-polyfill";
import type { BackgroundMessage } from "../lib/messages";
import { getSettings, saveSettings } from "../lib/settings";
import {
  clearCaptures,
  createCapture,
  deleteCapture,
  getCapture,
  getCaptureStats,
  listCaptures,
  listCapturesForPage
} from "../lib/storage";
import { syncCaptures } from "../lib/strixApi";
import type { CaptureDraft } from "../types/capture";

const IMAGE_MENU_ID = "strix-save-image";
const pendingRestores = new Map<number, { scrollY?: number; textQuote?: string }>();

browser.runtime.onInstalled.addListener(async () => {
  await browser.contextMenus.removeAll();
  await browser.contextMenus.create({
    id: IMAGE_MENU_ID,
    title: "Save image to Strix",
    contexts: ["image"]
  });
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== IMAGE_MENU_ID || !info.srcUrl) {
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
      return clearCaptures().then(() => ({ ok: true }));
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

  const url = urlWithTextFragment(
    capture.source.url,
    capture.context.textFragment ?? capture.context.textQuote
  );
  const tab = await browser.tabs.create({ url });

  if (tab.id && (capture.context.scrollY !== undefined || capture.context.textQuote)) {
    pendingRestores.set(tab.id, {
      scrollY: capture.context.scrollY,
      textQuote: capture.context.textQuote
    });
  }
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
