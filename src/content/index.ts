import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { ContentMessage } from "../lib/messages";
import type {
  CaptureDestinationTarget,
  CaptureDraft,
  CaptureSource
} from "../types/capture";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});

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

function destination(target?: CaptureDestinationTarget) {
  return target ? { target } : undefined;
}

function extractDraft(message: ContentMessage): CaptureDraft {
  const source = getSource();
  const selectionText = selectedText();

  if (message.kind === "selection") {
    return {
      kind: "selection",
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
      viewport: getViewport()
    },
    destination: destination(message.defaultDestination)
  };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as ContentMessage;

  if (request.type !== "strix:extract") {
    return false;
  }

  sendResponse(extractDraft(request));
  return false;
});
