import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import browser from "webextension-polyfill";
import type {
  ContentMessage,
  CreateCaptureResponse,
  ListCapturesResponse
} from "../lib/messages";
import type {
  CaptureDestinationTarget,
  CaptureDraft,
  CaptureRecord,
  CaptureSource
} from "../types/capture";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});
const TOOLBAR_ID = "strix-highlight-toolbar";
const HIGHLIGHT_CLASS = "strix-restored-highlight";

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

function extractDraft(message: Extract<ContentMessage, { type: "strix:extract" }>): CaptureDraft {
  const source = getSource();
  const selectionText = selectedText();

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

  if (request.type === "strix:restore-context") {
    restoreContext(request.textQuote, request.scrollY);
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
    "align-items:center",
    "gap:8px",
    "padding:6px 8px",
    "border:1px solid rgba(255,255,255,0.16)",
    "border-radius:6px",
    "background:#111",
    "box-shadow:0 8px 24px rgba(0,0,0,0.28)",
    "color:#f4efe7",
    "font:12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
  ].join(";");

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Save highlight";
  button.style.cssText = [
    "border:0",
    "border-radius:4px",
    "background:#d5cbbf",
    "color:#111",
    "cursor:pointer",
    "font:600 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "padding:6px 8px"
  ].join(";");
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => {
    saveHighlightFromSelection().catch(() => undefined);
  });

  toolbar.append(button);
  document.documentElement.append(toolbar);
  return toolbar;
}

function updateToolbarPosition(): void {
  const toolbar = ensureToolbar();
  const selection = window.getSelection();

  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    hideToolbar();
    return;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    hideToolbar();
    return;
  }

  toolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - 150, rect.left))}px`;
  toolbar.style.top = `${Math.max(8, rect.top - 42)}px`;
  toolbar.style.display = "flex";
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

  const response = (await browser.runtime.sendMessage({
    type: "captures:create",
    draft
  })) as CreateCaptureResponse;

  restoreHighlight(response.capture);
  window.getSelection()?.removeAllRanges();
  hideToolbar();
}

async function restoreStoredHighlights(): Promise<void> {
  const source = getSource();
  const response = (await browser.runtime.sendMessage({
    type: "captures:for-url",
    url: source.url,
    canonicalUrl: source.canonicalUrl
  })) as ListCapturesResponse;

  for (const capture of response.captures) {
    if (capture.kind === "highlight") {
      restoreHighlight(capture);
    }
  }
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
  mark.style.cssText = "background:rgba(213,203,191,0.38); border-radius:2px; box-shadow:0 0 0 1px rgba(213,203,191,0.12);";

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
  window.setTimeout(updateToolbarPosition, 0);
});
document.addEventListener("keyup", () => window.setTimeout(updateToolbarPosition, 0));
document.addEventListener("scroll", hideToolbar, { passive: true });

restoreStoredHighlights().catch(() => undefined);
