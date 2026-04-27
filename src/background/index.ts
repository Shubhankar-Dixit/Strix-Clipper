import browser from "webextension-polyfill";
import type { BackgroundMessage } from "../lib/messages";
import { getSettings, saveSettings } from "../lib/settings";
import {
  clearCaptures,
  createCapture,
  getCaptureStats,
  listCaptures
} from "../lib/storage";
import { syncCaptures } from "../lib/strixApi";
import type { CaptureDraft } from "../types/capture";

const IMAGE_MENU_ID = "strix-save-image";

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
    case "captures:list":
      return listCaptures(request.limit).then((captures) => ({ captures }));
    case "captures:stats":
      return getCaptureStats().then((stats) => ({ stats }));
    case "captures:sync":
      return getSettings().then(syncCaptures);
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
