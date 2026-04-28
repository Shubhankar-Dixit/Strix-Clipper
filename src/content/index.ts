import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type {
  ContentMessage,
  CreateCaptureResponse,
  ListCapturesResponse
} from "../lib/messages";
import type {
  CaptureDestinationTarget,
  CaptureDraft,
  CaptureRecord,
  CaptureSource,
  CaptureContext
} from "../types/capture";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});
const TOOLBAR_ID = "strix-highlight-toolbar";
const HIGHLIGHT_CLASS = "strix-restored-highlight";
const HIGHLIGHT_STYLE_ID = "strix-highlight-style";
const HIGHLIGHT_MODE_CLASS = "strix-highlight-mode-active";

let pageHighlights: CaptureRecord[] = [];
let highlightModeActive = false;
let highlightFocusIndex = 0;
let autoHighlightInFlight = false;
let autoHighlightTimer: number | undefined;

function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

function meta(selector: string): string | undefined {
  return document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || undefined;
}

function getCanonicalUrl(): string | undefined {
  return document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
}

function getFaviconUrl(): string | undefined {
  const icon =
    document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
    document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]') ??
    document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');

  return icon?.href;
}

function getSource(): CaptureSource {
  const capturedAt = new Date().toISOString();

  return {
    url: location.href,
    canonicalUrl: getCanonicalUrl(),
    title:
      meta('meta[property="og:title"]') ??
      meta('meta[name="twitter:title"]') ??
      document.title,
    siteName: meta('meta[property="og:site_name"]'),
    author:
      meta('meta[name="author"]') ??
      meta('meta[property="article:author"]') ??
      undefined,
    publishedAt:
      meta('meta[property="article:published_time"]') ??
      meta('meta[name="date"]') ??
      undefined,
    faviconUrl: getFaviconUrl(),
    capturedAt
  };
}

function getViewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight
  };
}

function extractArticle() {
  const clone = document.cloneNode(true) as Document;
  const article = new Readability(clone).parse();

  if (!article) {
    return {
      text: document.body?.innerText?.trim(),
      markdown: undefined,
      html: undefined,
      excerpt: meta('meta[name="description"]') ?? meta('meta[property="og:description"]')
    };
  }

  return {
    text: article.textContent?.trim() || undefined,
    markdown: article.content ? turndown.turndown(article.content) : undefined,
    html: article.content || undefined,
    excerpt:
      article.excerpt ??
      meta('meta[name="description"]') ??
      meta('meta[property="og:description"]') ??
      undefined
  };
}

function selectedText(): string | undefined {
  return window.getSelection()?.toString().trim() || undefined;
}

function getPageKey(source = getSource()): string {
  return source.canonicalUrl ?? source.url;
}

function textFragment(text?: string): string | undefined {
  return text?.trim() || undefined;
}

function destination(target?: CaptureDestinationTarget) {
  return target ? { target } : undefined;
}

function secondsLabel(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function getYouTubeVideoId(url = location.href): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube.com")) {
      return parsed.searchParams.get("v") ?? undefined;
    }

    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0];
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function timestampedVideoUrl(timestampSeconds: number): string {
  try {
    const parsed = new URL(location.href);
    const seconds = String(Math.max(0, Math.floor(timestampSeconds)));

    if (parsed.hostname.includes("youtube.com") || parsed.hostname === "youtu.be") {
      parsed.searchParams.set("t", seconds);
      return parsed.toString();
    }

    parsed.hash = `t=${seconds}`;
    return parsed.toString();
  } catch {
    return location.href;
  }
}

function activeVideoElement(): HTMLVideoElement | undefined {
  const videos = [...document.querySelectorAll<HTMLVideoElement>("video")];
  return videos.find((video) => !video.paused && video.currentTime > 0) ?? videos[0];
}

function hasVideoMoment(): boolean {
  const video = activeVideoElement();
  return Boolean(video && Number.isFinite(video.currentTime) && video.currentTime > 0);
}

function isThreadLikePage(): boolean {
  const host = location.hostname.toLowerCase();
  return host.includes("twitter.com") || host.includes("x.com");
}

function getVideoAuthor(source: CaptureSource): string | undefined {
  const host = location.hostname.toLowerCase();
  if (host.includes("youtube.com")) {
    const channel =
      document.querySelector<HTMLElement>("ytd-video-owner-renderer #channel-name a") ??
      document.querySelector<HTMLElement>("#owner #channel-name a") ??
      document.querySelector<HTMLElement>('link[itemprop="name"]');

    const channelName =
      channel instanceof HTMLLinkElement
        ? channel.getAttribute("content") || channel.textContent
        : channel?.textContent;

    return channelName?.trim() || source.author;
  }

  return source.author;
}

function extractVideoMoment(source: CaptureSource, defaultDestination?: CaptureDestinationTarget): CaptureDraft {
  const video = activeVideoElement();
  const timestampSeconds = video?.currentTime ?? 0;
  const durationSeconds =
    video && Number.isFinite(video.duration) ? video.duration : undefined;
  const youtubeId = getYouTubeVideoId();
  const host = location.hostname.toLowerCase();
  const provider: NonNullable<CaptureContext["video"]>["provider"] = youtubeId
    ? "youtube"
    : host.includes("twitter.com") || host.includes("x.com")
      ? "x"
      : host.includes("vimeo.com")
        ? "vimeo"
        : "generic";
  const timeLabel = secondsLabel(timestampSeconds);
  const videoUrl = timestampedVideoUrl(timestampSeconds);
  const selectionText = selectedText();
  const note = selectionText || `Video moment at ${timeLabel}`;

  return {
    kind: "video-moment",
    source: {
      ...source,
      url: videoUrl,
      author: getVideoAuthor(source)
    },
    content: {
      selectionText,
      text: note,
      markdown: `[${source.title || "Video moment"} @ ${timeLabel}](${videoUrl})`,
      excerpt: note
    },
    context: {
      scrollY: window.scrollY,
      textQuote: selectionText,
      textFragment: textFragment(selectionText),
      pageKey: getPageKey(source),
      viewport: getViewport(),
      video: {
        provider,
        videoId: youtubeId,
        timestampSeconds,
        durationSeconds
      }
    },
    destination: destination(defaultDestination)
  };
}

function closestTweetArticle(): HTMLElement | undefined {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  const anchorElement =
    anchor instanceof Element ? anchor : anchor?.parentElement ?? undefined;
  return (
    anchorElement?.closest<HTMLElement>("article") ??
    document.querySelector<HTMLElement>("article") ?? undefined
  );
}

function extractThreadCapture(source: CaptureSource, defaultDestination?: CaptureDestinationTarget): CaptureDraft {
  const article = closestTweetArticle();
  const selectionText = selectedText();
  const articleText = article?.innerText?.trim();
  const text = selectionText || articleText || document.body?.innerText?.trim();
  const author =
    article?.querySelector<HTMLElement>('[data-testid="User-Name"]')?.innerText
      ?.split("\n")
      .filter(Boolean)
      .join(" ") || source.author;

  return {
    kind: "thread",
    source: {
      ...source,
      author
    },
    content: {
      selectionText,
      text,
      markdown: text ? `${text}\n\nSource: ${location.href}` : `Source: ${location.href}`,
      excerpt: text?.slice(0, 280)
    },
    context: {
      scrollY: window.scrollY,
      textQuote: selectionText,
      textFragment: textFragment(selectionText),
      pageKey: getPageKey(source),
      viewport: getViewport(),
      threadUrl: location.href
    },
    destination: destination(defaultDestination)
  };
}

function isSelectionEligibleForHighlight(): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return false;
  }

  const text = selection.toString().trim();
  if (!text) {
    return false;
  }

  const active = document.activeElement as HTMLElement | null;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.tagName === "SELECT" ||
      active.isContentEditable)
  ) {
    return false;
  }

  return true;
}

function queueAutoHighlight(): void {
  if (!highlightModeActive) {
    return;
  }

  if (autoHighlightTimer !== undefined) {
    window.clearTimeout(autoHighlightTimer);
  }

  autoHighlightTimer = window.setTimeout(() => {
    autoHighlightTimer = undefined;

    if (autoHighlightInFlight) {
      return;
    }

    if (!isSelectionEligibleForHighlight()) {
      updateToolbarPosition();
      return;
    }

    autoHighlightInFlight = true;
    saveHighlightFromSelection()
      .catch(() => undefined)
      .finally(() => {
        autoHighlightInFlight = false;
        updateToolbarPosition();
      });
  }, 60);
}

function jumpToHighlight(): void {
  if (!pageHighlights.length) {
    return;
  }

  const capture = pageHighlights[highlightFocusIndex % pageHighlights.length];
  const element = document.querySelector<HTMLElement>(`[data-strix-capture-id="${capture.id}"]`);

  if (element) {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  highlightFocusIndex = (highlightFocusIndex + 1) % pageHighlights.length;
}

function extractDraft(message: Extract<ContentMessage, { type: "strix:extract" }>): CaptureDraft {
  const source = getSource();
  const selectionText = selectedText();

  if (message.kind === "smart") {
    if (hasVideoMoment()) {
      return extractVideoMoment(source, message.defaultDestination);
    }

    if (isThreadLikePage()) {
      return extractThreadCapture(source, message.defaultDestination);
    }

    if (selectionText) {
      return extractDraft({
        type: "strix:extract",
        kind: "selection",
        defaultDestination: message.defaultDestination
      });
    }

    return extractDraft({
      type: "strix:extract",
      kind: "page",
      defaultDestination: message.defaultDestination
    });
  }

  if (message.kind === "video-moment") {
    return extractVideoMoment(source, message.defaultDestination);
  }

  if (message.kind === "thread") {
    return extractThreadCapture(source, message.defaultDestination);
  }

  if (message.kind === "selection" || message.kind === "highlight") {
    return {
      kind: message.kind,
      source,
      content: {
        selectionText,
        text: selectionText,
        markdown: selectionText,
        excerpt: selectionText
      },
      context: {
        scrollY: window.scrollY,
        textQuote: selectionText,
        textFragment: textFragment(selectionText),
        pageKey: getPageKey(source),
        viewport: getViewport()
      },
      destination: destination(message.defaultDestination)
    };
  }

  if (message.kind === "bookmark") {
    return {
      kind: "bookmark",
      source,
      content: {
        excerpt: meta('meta[name="description"]') ?? meta('meta[property="og:description"]')
      },
      context: {
        scrollY: window.scrollY,
        textQuote: selectionText,
        textFragment: textFragment(selectionText),
        pageKey: getPageKey(source),
        viewport: getViewport()
      },
      destination: destination(message.defaultDestination)
    };
  }

  const article = extractArticle();
  return {
    kind: "page",
    source,
    content: {
      ...article,
      selectionText
    },
    context: {
      scrollY: window.scrollY,
      textQuote: selectionText,
      textFragment: textFragment(selectionText),
      pageKey: getPageKey(source),
      viewport: getViewport()
    },
    destination: destination(message.defaultDestination)
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as ContentMessage;

  if (request.type === "strix:activate-highlight-mode") {
    activateHighlightMode();
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "strix:refresh-highlights") {
    refreshPageHighlights().catch(() => undefined);
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "strix:restore-context") {
    restoreContext(request.textQuote, request.scrollY);
    sendResponse({ success: true });
    return false;
  }

  if (request.type !== "strix:extract") {
    return false;
  }

  sendResponse(extractDraft(request));
  return false;
});

function ensureToolbar(): HTMLDivElement {
  const existing = document.getElementById(TOOLBAR_ID);
  if (existing instanceof HTMLDivElement) {
    return existing;
  }

  const toolbar = document.createElement("div");
  toolbar.id = TOOLBAR_ID;
  toolbar.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "display:none",
    "flex-direction:column",
    "align-items:flex-start",
    "gap:6px",
    "padding:0",
    "border:1px solid rgba(255,255,255,0.12)",
    "border-radius:999px",
    "background:linear-gradient(180deg, rgba(34,34,36,0.98), rgba(23,23,26,0.98))",
    "box-shadow:0 10px 28px rgba(0,0,0,0.35)",
    "backdrop-filter:blur(12px)",
    "color:#f4efe7",
    "font:12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
  ].join(";");

  const capsule = document.createElement("div");
  capsule.style.cssText = [
    "display:flex",
    "align-items:center",
    "gap:8px",
    "padding:6px 8px"
  ].join(";");

  const count = document.createElement("button");
  count.type = "button";
  count.id = "strix-highlight-count";
  count.setAttribute("aria-label", "Jump to highlighted text");
  count.textContent = "0";
  count.style.cssText = [
    "min-width:24px",
    "height:24px",
    "border:0",
    "padding:0 8px",
    "border-radius:999px",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "background:rgba(255,255,255,0.08)",
    "color:#dad3c8",
    "font:600 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
  ].join(";");
  count.addEventListener("mousedown", (event) => event.preventDefault());
  count.addEventListener("click", () => {
    jumpToHighlight();
  });

  const marker = document.createElement("span");
  marker.setAttribute("aria-hidden", "true");
  marker.style.cssText = [
    "width:14px",
    "height:14px",
    "display:inline-block",
    "background:linear-gradient(135deg, #f1d35f 0 48%, #1f1f22 48% 62%, #f4efe7 62%)",
    "border-radius:3px",
    "box-shadow:0 0 0 1px rgba(255,255,255,0.18)"
  ].join(";");

  capsule.append(marker);
  capsule.append(count);
  toolbar.append(capsule);
  document.documentElement.append(toolbar);
  return toolbar;
}

function updateToolbarPosition(): void {
  const toolbar = ensureToolbar();
  if (highlightModeActive || pageHighlights.length > 0) {
    toolbar.style.left = `${Math.max(8, window.innerWidth - 84)}px`;
    toolbar.style.top = "16px";
    toolbar.style.display = "flex";
    renderToolbarState();
    return;
  }

  hideToolbar();
}

function hideToolbar(): void {
  const toolbar = document.getElementById(TOOLBAR_ID);
  if (toolbar) {
    toolbar.style.display = "none";
  }
}

async function saveHighlightFromSelection(): Promise<void> {
  const draft = extractDraft({ type: "strix:extract", kind: "highlight" });
  if (!draft.content.selectionText) {
    hideToolbar();
    return;
  }

  const response = await sendRuntimeMessage<CreateCaptureResponse>({
    type: "captures:create",
    draft
  });

  restoreHighlight(response.capture);
  await refreshPageHighlights();
  window.getSelection()?.removeAllRanges();
  updateToolbarPosition();
}

async function refreshPageHighlights(): Promise<void> {
  const source = getSource();
  clearRenderedHighlights();
  const response = await sendRuntimeMessage<ListCapturesResponse>({
    type: "captures:for-url",
    url: source.url,
    canonicalUrl: source.canonicalUrl
  });

  pageHighlights = response.captures.filter((capture) => capture.kind === "highlight");
  highlightFocusIndex = 0;

  for (const capture of pageHighlights) {
    restoreHighlight(capture);
  }

  renderToolbarState();
  updateToolbarPosition();
}

function restoreHighlight(capture: CaptureRecord): void {
  const quote = capture.context.textQuote?.trim();
  if (!quote) {
    return;
  }

  if (document.querySelector(`[data-strix-capture-id="${capture.id}"]`)) {
    return;
  }

  wrapFirstTextMatch(quote, capture.id);
}

function renderToolbarState(): void {
  const toolbar = document.getElementById(TOOLBAR_ID);
  if (!toolbar) {
    return;
  }

  const count = toolbar.querySelector<HTMLButtonElement>("#strix-highlight-count");
  if (count) {
    count.textContent = String(pageHighlights.length);
  }
}

function removeHighlightFromPage(captureId: string): void {
  const highlight = document.querySelector<HTMLElement>(`[data-strix-capture-id="${captureId}"]`);
  if (!highlight) {
    return;
  }

  const fragment = document.createDocumentFragment();
  const children = [...highlight.childNodes];

  if (children.length === 0) {
    fragment.append(document.createTextNode(highlight.textContent ?? ""));
  } else {
    for (const child of children) {
      fragment.append(child);
    }
  }

  highlight.replaceWith(fragment);
}

function clearRenderedHighlights(): void {
  for (const highlight of [...document.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_CLASS}`)]) {
    const fragment = document.createDocumentFragment();
    const children = [...highlight.childNodes];

    if (children.length === 0) {
      fragment.append(document.createTextNode(highlight.textContent ?? ""));
    } else {
      for (const child of children) {
        fragment.append(child);
      }
    }

    highlight.replaceWith(fragment);
  }
}

async function deleteHighlight(capture: CaptureRecord): Promise<void> {
  await sendRuntimeMessage({
    type: "captures:delete",
    captureId: capture.id
  });

  removeHighlightFromPage(capture.id);
  pageHighlights = pageHighlights.filter((item) => item.id !== capture.id);
  highlightFocusIndex = 0;
  renderToolbarState();
  updateToolbarPosition();
}

function activateHighlightMode(): void {
  highlightModeActive = true;
  document.documentElement.classList.add(HIGHLIGHT_MODE_CLASS);
  renderToolbarState();
  updateToolbarPosition();
}

function ensureHighlightStyles(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      background: rgba(241, 211, 95, 0.34);
      border-radius: 999px;
      box-shadow: inset 0 0 0 1px rgba(176, 148, 79, 0.45);
      padding: 0.05em 0.18em;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }

    .${HIGHLIGHT_MODE_CLASS},
    .${HIGHLIGHT_MODE_CLASS} body,
    .${HIGHLIGHT_MODE_CLASS} body * {
      cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cpath fill='%23f1d35f' d='M5 19 18.8 5.2l4 4L9 23H5z'/%3E%3Cpath fill='%23212124' d='m17.2 6.8 1.6-1.6 4 4-1.6 1.6zM5 19l4 4H5z'/%3E%3Cpath fill='%23f4efe7' d='m9 23 12.2-12.2 1.8 1.8L10.8 24.8z' opacity='.75'/%3E%3C/svg%3E") 5 23, text !important;
    }

    #${TOOLBAR_ID},
    #${TOOLBAR_ID} * {
      cursor: default !important;
    }
  `;
  document.documentElement.append(style);
}

function wrapFirstTextMatch(quote: string, captureId: string): boolean {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(`#${TOOLBAR_ID}, .${HIGHLIGHT_CLASS}`)) {
        return NodeFilter.FILTER_REJECT;
      }

      if (["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "NOSCRIPT"].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }

      return node.textContent?.includes(quote)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    }
  });

  const node = walker.nextNode();
  if (!node?.textContent) {
    return false;
  }

  const index = node.textContent.indexOf(quote);
  if (index < 0) {
    return false;
  }

  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + quote.length);

  const mark = document.createElement("span");
  mark.className = HIGHLIGHT_CLASS;
  mark.dataset.strixCaptureId = captureId;

  try {
    range.surroundContents(mark);
    return true;
  } catch {
    return false;
  }
}

function restoreContext(textQuote?: string, scrollY?: number): void {
  window.setTimeout(() => {
    if (textQuote) {
      const restored = [...document.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_CLASS}`)]
        .find((element) => element.textContent?.trim() === textQuote.trim());
      if (restored) {
        restored.scrollIntoView({ block: "center" });
        return;
      }
    }

    if (scrollY !== undefined) {
      window.scrollTo({ top: scrollY, behavior: "smooth" });
    }
  }, 200);
}

document.addEventListener("mouseup", (event) => {
  if ((event.target as Element | null)?.closest(`#${TOOLBAR_ID}`)) {
    return;
  }
  window.setTimeout(queueAutoHighlight, 0);
});
document.addEventListener("keyup", () => window.setTimeout(queueAutoHighlight, 0));
document.addEventListener("selectionchange", () => window.setTimeout(queueAutoHighlight, 0));
document.addEventListener("scroll", () => window.setTimeout(updateToolbarPosition, 0), { passive: true });

ensureHighlightStyles();
refreshPageHighlights().catch(() => undefined);
