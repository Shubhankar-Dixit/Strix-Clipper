import { Readability } from "@mozilla/readability";
import Defuddle from "defuddle";
import TurndownService from "turndown";
import type {
  ContentMessage,
  ContentExtractKind,
  CreateCaptureResponse,
  ListCapturesResponse
} from "../lib/messages";
import type {
  CaptureDestinationTarget,
  CaptureExtractionSettings,
  CaptureDraft,
  CaptureRecord,
  CaptureSource,
  CaptureContext,
  PageFormFieldState
} from "../types/capture";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});
const TOOLBAR_ID = "strix-highlight-toolbar";
const HIGHLIGHT_CLASS = "strix-restored-highlight";
const HIGHLIGHT_STYLE_ID = "strix-highlight-style";
const HIGHLIGHT_MODE_CLASS = "strix-highlight-mode-active";
const CLIP_FEEDBACK_STYLE_ID = "strix-clip-feedback-style";
const CLIP_FEEDBACK_CLASS = "strix-clip-feedback";
const HIGHLIGHT_ACTIVE_CLASS = "strix-restored-highlight-active";
const MAX_FALLBACK_TEXT_LENGTH = 90_000;
const MAX_MARKDOWN_LENGTH = 180_000;
const MIN_FALLBACK_TEXT_LENGTH = 280;
const READABILITY_OPTIONS = {
  charThreshold: 280,
  nbTopCandidates: 8,
  maxElemsToParse: 0,
  keepClasses: false,
  linkDensityModifier: -0.05
};
const DEFAULT_EXTRACTION_SETTINGS: CaptureExtractionSettings = {
  defaultCaptureMode: "smart",
  articleCleanupMode: "smart",
  includeImages: true,
  includeReplies: false,
  preferredLanguage: ""
};

type ExtractedArticle = {
  title?: string;
  author?: string;
  publishedAt?: string;
  siteName?: string;
  text?: string;
  markdown?: string;
  html?: string;
  excerpt?: string;
  imageUrls?: string[];
};

type SiteExtractor = {
  matches: (host: string) => boolean;
  extract: (source: CaptureSource, settings: CaptureExtractionSettings) => ExtractedArticle | undefined;
};

let pageHighlights: CaptureRecord[] = [];
let highlightModeActive = false;
let highlightFocusIndex = 0;
let activeHighlightId: string | undefined;
let autoHighlightInFlight = false;
let autoHighlightTimer: number | undefined;
let jsonLdCache: Record<string, string[]> | undefined;
let jsonLdDataCache: unknown[] | undefined;

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

function firstText(selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const text = document.querySelector<HTMLElement>(selector)?.textContent?.trim();
    if (text) {
      return normalizeWhitespace(text);
    }
  }

  return undefined;
}

function jsonLdValues(key: string): string[] {
  if (jsonLdCache?.[key]) {
    return jsonLdCache[key];
  }

  jsonLdCache ??= {};
  const values: string[] = [];

  for (const parsed of jsonLdData()) {
    collectJsonLdValues(parsed, key, values);
  }

  jsonLdCache[key] = values.map((value) => value.trim()).filter(Boolean);
  return jsonLdCache[key];
}

function jsonLdData(): unknown[] {
  if (jsonLdDataCache) {
    return jsonLdDataCache;
  }

  jsonLdDataCache = [];

  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    const raw = script.textContent?.trim();
    if (!raw) {
      continue;
    }

    try {
      jsonLdDataCache.push(JSON.parse(raw) as unknown);
    } catch {
      continue;
    }
  }

  return jsonLdDataCache;
}

function collectJsonLdValues(input: unknown, key: string, values: string[]): void {
  if (!input) {
    return;
  }

  if (Array.isArray(input)) {
    input.forEach((item) => collectJsonLdValues(item, key, values));
    return;
  }

  if (typeof input !== "object") {
    return;
  }

  const record = input as Record<string, unknown>;
  const value = record[key];
  if (typeof value === "string") {
    values.push(value);
  } else if (value && typeof value === "object") {
    const nested = value as Record<string, unknown>;
    const name = nested.name;
    if (typeof name === "string") {
      values.push(name);
    }
  }

  Object.values(record).forEach((item) => collectJsonLdValues(item, key, values));
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
  const visibleTitle = firstText(["#firstHeading", "main h1", "article h1", "[role='main'] h1", "h1"]);
  const jsonTitle = jsonLdValues("headline")[0];
  const jsonAuthor = jsonLdValues("author")[0];
  const jsonPublished = jsonLdValues("datePublished")[0];
  const redditRoot = isRedditHost() ? redditPostRoot() : undefined;
  const redditTitle = redditRoot
    ? redditAttribute(redditRoot, ["post-title", "data-title"]) ??
      redditTextFromSelectors(redditRoot, ["h1", "[slot='title']", "a.title", "[data-testid='post-title']"])
    : undefined;
  const redditAuthor = redditRoot
    ? redditAttribute(redditRoot, ["author", "data-author"]) ??
      redditTextFromSelectors(redditRoot, ["[slot='authorName']", "a[href*='/user/']", ".author"])
    : undefined;

  return {
    url: location.href,
    canonicalUrl: getCanonicalUrl(),
    title:
      redditTitle ??
      visibleTitle ??
      meta('meta[property="og:title"]') ??
      meta('meta[name="twitter:title"]') ??
      jsonTitle ??
      cleanDocumentTitle(document.title),
    siteName: meta('meta[property="og:site_name"]'),
    author:
      redditAuthor ??
      meta('meta[name="author"]') ??
      meta('meta[property="article:author"]') ??
      jsonAuthor ??
      undefined,
    publishedAt:
      meta('meta[property="article:published_time"]') ??
      meta('meta[name="date"]') ??
      jsonPublished ??
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

function normalizeWhitespace(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

function cleanDocumentTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }

  return normalizeWhitespace(title)
    .replace(/\s+-\s+Wikipedia$/i, "")
    .replace(/\s+\|\s+Wikipedia$/i, "")
    .trim() || undefined;
}

function normalizeExtractionSettings(
  settings: Partial<CaptureExtractionSettings> | undefined
): CaptureExtractionSettings {
  return {
    ...DEFAULT_EXTRACTION_SETTINGS,
    ...settings,
    defaultCaptureMode:
      settings?.defaultCaptureMode === "page" ||
      settings?.defaultCaptureMode === "selection" ||
      settings?.defaultCaptureMode === "bookmark" ||
      settings?.defaultCaptureMode === "smart"
        ? settings.defaultCaptureMode
        : DEFAULT_EXTRACTION_SETTINGS.defaultCaptureMode,
    articleCleanupMode:
      settings?.articleCleanupMode === "reader" ||
      settings?.articleCleanupMode === "loose" ||
      settings?.articleCleanupMode === "smart"
        ? settings.articleCleanupMode
        : DEFAULT_EXTRACTION_SETTINGS.articleCleanupMode,
    includeImages: settings?.includeImages !== false,
    includeReplies: settings?.includeReplies === true,
    preferredLanguage: settings?.preferredLanguage?.trim() ?? ""
  };
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}\n\n[Content truncated]` : value;
}

function pageDescription(): string | undefined {
  return (
    meta('meta[name="description"]') ??
    meta('meta[property="og:description"]') ??
    jsonLdValues("description")[0]
  );
}

function cleanClone(root: ParentNode = document): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const clone = root instanceof Document ? root.body?.cloneNode(true) : (root as Element).cloneNode(true);

  if (clone) {
    fragment.append(clone);
  }

  for (const element of [...fragment.querySelectorAll<HTMLElement>([
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "svg",
    "canvas",
    "video",
    "audio",
    "form",
    "button",
    "input",
    "textarea",
    "select",
    "nav",
    "footer",
    "aside",
    "[hidden]",
    "[aria-hidden='true']",
    "[role='navigation']",
    "[role='banner']",
    "[role='complementary']",
    "[role='dialog']",
    "[data-testid='placementTracking']",
    ".advertisement",
    ".ads",
    ".ad",
    ".cookie",
    ".newsletter",
    ".subscribe",
    ".share",
    ".social",
    ".sidebar",
    ".comments"
  ].join(","))]) {
    element.remove();
  }

  return fragment;
}

function nodeToArticle(root: ParentNode, excerpt = pageDescription()): ExtractedArticle | undefined {
  const fragment = cleanClone(root);
  const wrapper = document.createElement("article");
  wrapper.append(fragment);
  const text = normalizeWhitespace(wrapper.innerText || wrapper.textContent || "");

  if (text.length < 40) {
    return undefined;
  }

  const html = wrapper.innerHTML;
  return {
    text: truncate(text, MAX_FALLBACK_TEXT_LENGTH),
    markdown: truncate(turndown.turndown(html), MAX_MARKDOWN_LENGTH),
    html,
    excerpt: excerpt ?? text.slice(0, 280),
    imageUrls: extractImageUrls(wrapper)
  };
}

function extractImageUrls(root: ParentNode = document): string[] | undefined {
  const urls = new Set<string>();

  root.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const source =
      image.currentSrc ||
      image.src ||
      image.getAttribute("data-src") ||
      image.getAttribute("data-original");

    if (source && !source.startsWith("data:")) {
      urls.add(new URL(source, location.href).href);
    }
  });

  return urls.size ? [...urls].slice(0, 12) : undefined;
}

function documentFromFragment(fragment: DocumentFragment): Document {
  const doc = document.implementation.createHTMLDocument(document.title);
  doc.body.append(fragment);
  return doc;
}

function extractReadability(): ExtractedArticle | undefined {
  const article = new Readability(documentFromFragment(cleanClone(document)), READABILITY_OPTIONS).parse();

  if (!article) {
    return undefined;
  }

  const content = article.content || "";
  return {
    text: truncate(normalizeWhitespace(article.textContent || ""), MAX_FALLBACK_TEXT_LENGTH),
    markdown: content ? truncate(turndown.turndown(content), MAX_MARKDOWN_LENGTH) : undefined,
    html: content || undefined,
    excerpt:
      article.excerpt ??
      pageDescription(),
    imageUrls: content ? extractImageUrls(documentFromFragment(document.createRange().createContextualFragment(content))) : extractImageUrls()
  };
}

function extractDefuddle(
  source: CaptureSource,
  settings: CaptureExtractionSettings
): ExtractedArticle | undefined {
  const result = new Defuddle(document, {
    url: source.url,
    markdown: false,
    separateMarkdown: false,
    removeImages: !settings.includeImages,
    includeReplies: settings.includeReplies,
    language: settings.preferredLanguage || document.documentElement.lang || undefined,
    useAsync: false,
    removeLowScoring: settings.articleCleanupMode !== "loose",
    standardize: true
  }).parse();

  const content = result.content || "";
  const fragment = content
    ? document.createRange().createContextualFragment(content)
    : undefined;
  const contentDocument = fragment ? documentFromFragment(fragment) : undefined;
  const text = normalizeWhitespace(contentDocument?.body?.innerText || contentDocument?.body?.textContent || "");

  if (!content || text.length < 40) {
    return undefined;
  }

  return {
    title: cleanDocumentTitle(result.title) ?? undefined,
    author: normalizeWhitespace(result.author || "") || undefined,
    publishedAt: normalizeWhitespace(result.published || "") || undefined,
    siteName: normalizeWhitespace(result.site || result.domain || "") || undefined,
    text: truncate(text, MAX_FALLBACK_TEXT_LENGTH),
    markdown: truncate(turndown.turndown(content), MAX_MARKDOWN_LENGTH),
    html: content,
    excerpt: normalizeWhitespace(result.description || "") || pageDescription(),
    imageUrls: settings.includeImages && contentDocument ? extractImageUrls(contentDocument) : undefined
  };
}

function elementScore(element: HTMLElement): number {
  const text = normalizeWhitespace(element.innerText || "");
  const textLength = text.length;
  if (textLength < MIN_FALLBACK_TEXT_LENGTH) {
    return 0;
  }

  const linkTextLength = [...element.querySelectorAll<HTMLAnchorElement>("a")]
    .reduce((sum, link) => sum + normalizeWhitespace(link.innerText || "").length, 0);
  const linkDensity = linkTextLength / Math.max(textLength, 1);
  const paragraphCount = element.querySelectorAll("p, li, pre, blockquote, h1, h2, h3").length;
  const mediaBonus = Math.min(element.querySelectorAll("img, video, table").length, 8) * 30;
  const roleBonus = /^(ARTICLE|MAIN)$/.test(element.tagName) ? 500 : 0;

  return textLength * (1 - Math.min(linkDensity, 0.9)) + paragraphCount * 120 + mediaBonus + roleBonus;
}

function rootContentScore(element: HTMLElement): number {
  const text = normalizeWhitespace(element.innerText || element.textContent || "");
  const textLength = text.length;
  if (textLength < 40) {
    return 0;
  }

  const linkTextLength = [...element.querySelectorAll<HTMLAnchorElement>("a")]
    .reduce((sum, link) => sum + normalizeWhitespace(link.innerText || link.textContent || "").length, 0);
  const linkDensity = linkTextLength / Math.max(textLength, 1);
  const paragraphCount = element.querySelectorAll("p, li, pre, blockquote").length;
  const headingCount = element.querySelectorAll("h1, h2, h3").length;
  const embedCount = element.querySelectorAll("iframe, video, audio, embed, object, [class*='embed'], [data-testid*='embed']").length;
  const articleBonus = element.matches("article, main, [role='main'], .available-content, .post-content, .body")
    ? 500
    : 0;

  return textLength * (1 - Math.min(linkDensity, 0.95)) + paragraphCount * 160 + headingCount * 90 + articleBonus - embedCount * 260;
}

function extractDensityFallback(): ExtractedArticle | undefined {
  const candidates = [...document.querySelectorAll<HTMLElement>("article, main, [role='main'], section, div")]
    .filter((element) => !element.closest(`#${TOOLBAR_ID}`));

  const best = candidates
    .map((element) => ({ element, score: elementScore(element) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score < MIN_FALLBACK_TEXT_LENGTH) {
    const text = normalizeWhitespace(document.body?.innerText || "");
    return text
      ? {
          text: truncate(text, MAX_FALLBACK_TEXT_LENGTH),
          excerpt: pageDescription() ?? text.slice(0, 280),
          imageUrls: extractImageUrls()
        }
      : {
          excerpt: pageDescription()
        };
  }

  return nodeToArticle(best.element);
}

function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isSubstackHost(host = location.hostname.toLowerCase()): boolean {
  return hostMatches(host, ["substack.com"]) || host.includes("substack");
}

function isRedditHost(host = location.hostname.toLowerCase()): boolean {
  return hostMatches(host, ["reddit.com"]);
}

function extractionRoot(selectors: string[]): HTMLElement | undefined {
  const candidates: HTMLElement[] = [];

  for (const selector of selectors) {
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      if (!element.closest(`#${TOOLBAR_ID}`)) {
        candidates.push(element);
      }
    });
  }

  const ranked = candidates
    .map((element) => ({ element, score: rootContentScore(element) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.element;
}

function extractYouTubePage(source: CaptureSource): ExtractedArticle | undefined {
  const title = firstText(["h1.ytd-watch-metadata", "h1.title", "ytd-watch-metadata h1"]);
  const channel = firstText(["ytd-video-owner-renderer #channel-name", "#owner #channel-name"]);
  const description = firstText([
    "ytd-text-inline-expander #description-inline-expander",
    "#description-inline-expander",
    "#description"
  ]);
  const transcriptSegments = [...document.querySelectorAll<HTMLElement>("ytd-transcript-segment-renderer, ytd-transcript-segment-list-renderer [role='button']")]
    .map((segment) => normalizeWhitespace(segment.innerText || ""))
    .filter(Boolean);
  const transcript = transcriptSegments.length ? transcriptSegments.join("\n") : undefined;
  const lines = [
    title ? `# ${title}` : undefined,
    channel ? `Channel: ${channel}` : undefined,
    description,
    transcript ? `## Transcript\n\n${transcript}` : undefined
  ].filter(Boolean) as string[];
  const text = normalizeWhitespace(lines.join("\n\n"));

  if (!text) {
    return undefined;
  }

  return {
    text: truncate(text, MAX_FALLBACK_TEXT_LENGTH),
    markdown: truncate(text, MAX_MARKDOWN_LENGTH),
    excerpt: description ?? source.title,
    imageUrls: extractImageUrls()
  };
}

function extractXPage(source: CaptureSource): ExtractedArticle | undefined {
  const articles = [...document.querySelectorAll<HTMLElement>("article")].filter((article) => {
    const text = normalizeWhitespace(article.innerText || "");
    return text.length > 20 && !article.closest(`#${TOOLBAR_ID}`);
  });

  if (!articles.length) {
    return undefined;
  }

  const text = normalizeWhitespace(articles.map((article) => article.innerText).join("\n\n---\n\n"));
  return {
    text: truncate(text, MAX_FALLBACK_TEXT_LENGTH),
    markdown: truncate(`${text}\n\nSource: ${location.href}`, MAX_MARKDOWN_LENGTH),
    excerpt: text.slice(0, 280),
    imageUrls: extractImageUrls(document),
    html: articles.map((article) => article.outerHTML).join("\n")
  };
}

function redditAttribute(element: Element | undefined, names: string[]): string | undefined {
  if (!element) {
    return undefined;
  }

  for (const name of names) {
    const value = element.getAttribute(name)?.trim();
    if (value) {
      return normalizeWhitespace(value);
    }
  }

  return undefined;
}

function redditCleanText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const text = normalizeWhitespace(value)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }

      return !/^(upvote|downvote|reply|share|save|hide|report|award|sort by|view discussions?|add a comment|log in|sign up)$/i.test(line);
    })
    .join("\n");

  return text || undefined;
}

function redditTextFromSelectors(root: ParentNode, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const element = root.querySelector<HTMLElement>(selector);
    const text = redditCleanText(element?.innerText || element?.textContent || undefined);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function redditMarkdownLink(label: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value, location.href).href;
    return `[${label}](${url})`;
  } catch {
    return undefined;
  }
}

function redditPostRoot(): HTMLElement | undefined {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  const anchorElement =
    anchor instanceof Element ? anchor : anchor?.parentElement ?? undefined;

  return (
    anchorElement?.closest<HTMLElement>("shreddit-post, [data-testid='post-container'], .thing.link, article") ??
    document.querySelector<HTMLElement>("shreddit-post") ??
    document.querySelector<HTMLElement>("[data-testid='post-container']") ??
    document.querySelector<HTMLElement>(".thing.link") ??
    document.querySelector<HTMLElement>("article")
  ) ?? undefined;
}

function redditPostBody(root: ParentNode): string | undefined {
  return redditTextFromSelectors(root, [
    "[slot='text-body']",
    "[data-post-click-location='text-body']",
    "[data-testid='post-content']",
    ".usertext-body .md",
    ".expando .md",
    "[data-click-id='text']",
    "div[data-adclicklocation='media'] + div"
  ]);
}

function redditCommentText(comment: HTMLElement): string | undefined {
  return redditTextFromSelectors(comment, [
    "[slot='comment']",
    "[slot='comment-body']",
    "[data-testid='comment']",
    ".usertext-body .md",
    ".md"
  ]);
}

function redditCommentMarkdown(comment: HTMLElement): string | undefined {
  const text = redditCommentText(comment);
  if (!text || text.length < 12) {
    return undefined;
  }

  const author =
    redditAttribute(comment, ["author", "data-author"]) ??
    redditTextFromSelectors(comment, ["[slot='commentMeta'] a[href*='/user/']", "a[href*='/user/']", ".author"]);
  const score =
    redditAttribute(comment, ["score", "data-score"]) ??
    redditTextFromSelectors(comment, ["[slot='vote-score']", ".score"]);
  const prefix = [author ? `u/${author.replace(/^u\//, "")}` : undefined, score].filter(Boolean).join(" - ");
  const body = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return `${prefix ? `**${prefix}**\n` : ""}${body}`;
}

function redditTopComments(limit = 8): string[] {
  const comments = [
    ...document.querySelectorAll<HTMLElement>("shreddit-comment, [data-testid='comment'], .comment")
  ].filter((comment) => !comment.closest(`#${TOOLBAR_ID}`));
  const seen = new Set<string>();
  const result: string[] = [];

  for (const comment of comments) {
    const markdown = redditCommentMarkdown(comment);
    if (!markdown) {
      continue;
    }

    const key = markdown.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(markdown);

    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function extractRedditPage(
  source: CaptureSource,
  settings: CaptureExtractionSettings
): ExtractedArticle | undefined {
  const root = redditPostRoot();
  if (!root) {
    return undefined;
  }

  const title =
    redditAttribute(root, ["post-title", "data-title"]) ??
    redditTextFromSelectors(root, ["h1", "[slot='title']", "a.title", "[data-testid='post-title']"]) ??
    source.title?.replace(/\s*:\s*r\/.+$/i, "");
  const author =
    redditAttribute(root, ["author", "data-author"]) ??
    redditTextFromSelectors(root, ["[slot='authorName']", "a[href*='/user/']", ".author"]);
  const subreddit =
    redditAttribute(root, ["subreddit-prefixed-name", "subreddit-name", "data-subreddit-prefixed-name", "data-subreddit"]) ??
    redditTextFromSelectors(root, ["a[href^='/r/']", "a[href*='/r/']"]);
  const score =
    redditAttribute(root, ["score", "data-score"]) ??
    redditTextFromSelectors(root, ["[slot='vote-score']", "[data-testid='vote-arrows'] faceplate-number", ".score"]);
  const body = redditPostBody(root);
  const contentHref = redditAttribute(root, ["content-href", "url", "data-url"]);
  const outboundLink = redditMarkdownLink("Linked content", contentHref);
  const permalink = redditAttribute(root, ["permalink", "data-permalink"]);
  const redditLink = redditMarkdownLink("Reddit discussion", permalink ?? location.href);
  const imageUrls = settings.includeImages ? extractImageUrls(root) ?? extractImageUrls(document) : undefined;
  const comments = settings.includeReplies ? redditTopComments() : [];
  const lines = [
    title ? `# ${title}` : undefined,
    subreddit || author || score
      ? [subreddit, author ? `u/${author.replace(/^u\//, "")}` : undefined, score ? `${score} points` : undefined].filter(Boolean).join(" | ")
      : undefined,
    body,
    outboundLink && contentHref !== permalink ? outboundLink : undefined,
    redditLink,
    comments.length ? `## Top comments\n\n${comments.join("\n\n")}` : undefined
  ].filter(Boolean) as string[];
  const markdown = lines.join("\n\n");
  const text = redditCleanText(lines.join("\n\n"));

  if (!text) {
    return undefined;
  }

  return {
    text: truncate(text, MAX_FALLBACK_TEXT_LENGTH),
    markdown: truncate(markdown, MAX_MARKDOWN_LENGTH),
    html: root.outerHTML,
    excerpt: body ?? title ?? pageDescription(),
    imageUrls
  };
}

function extractWikipediaPage(): ExtractedArticle | undefined {
  const root = extractionRoot(["#mw-content-text .mw-parser-output", "main"]);
  if (!root) {
    return undefined;
  }

  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll([
    ".navbox",
    ".metadata",
    ".ambox",
    ".infobox",
    ".mw-editsection",
    ".reference",
    ".reflist",
    ".hatnote",
    ".shortdescription",
    "#toc"
  ].join(",")).forEach((element) => element.remove());

  return nodeToArticle(clone);
}

function extractSubstackPage(): ExtractedArticle | undefined {
  const root = extractionRoot([
    "article .available-content",
    "article .post-content",
    "article .body",
    ".available-content",
    ".post-content",
    ".post-body",
    ".single-post",
    ".note-content",
    "[data-testid='post-content']",
    "[data-testid='note-content']",
    "article",
    "[role='article']",
    ".body",
    "main"
  ]);

  return root ? nodeToArticle(root) : undefined;
}

function extractPopularPage(): ExtractedArticle | undefined {
  const root = extractionRoot([
    "article",
    "main article",
    "main [data-testid='post-container']",
    "[role='main'] article",
    ".markdown-body",
    "#readme",
    ".repository-content",
    ".Box-body",
    ".post",
    ".available-content",
    ".post-content",
    ".entry-content",
    ".article-content",
    ".content",
    "main"
  ]);

  return root ? nodeToArticle(root) : undefined;
}

const siteExtractors: SiteExtractor[] = [
  {
    matches: (host) => hostMatches(host, ["youtube.com", "youtu.be"]),
    extract: extractYouTubePage
  },
  {
    matches: (host) => hostMatches(host, ["x.com", "twitter.com"]),
    extract: extractXPage
  },
  {
    matches: isRedditHost,
    extract: extractRedditPage
  },
  {
    matches: (host) => hostMatches(host, ["wikipedia.org"]),
    extract: extractWikipediaPage
  },
  {
    matches: isSubstackHost,
    extract: extractSubstackPage
  },
  {
    matches: (host) => hostMatches(host, ["github.com", "medium.com", "docs.github.com", "developer.mozilla.org", "stackoverflow.com"]),
    extract: extractPopularPage
  }
];

function articleQuality(article: ExtractedArticle | undefined): number {
  if (!article?.text) {
    return 0;
  }

  const textLength = article.text.length;
  const markdownLength = article.markdown?.length ?? 0;
  const headingCount = (article.markdown?.match(/^#{1,3}\s+/gm) ?? []).length;
  const linkCount = (article.markdown?.match(/\]\(/g) ?? []).length;
  const linkPenalty = Math.min(linkCount * 20, textLength * 0.35);

  return textLength + Math.min(markdownLength, textLength) * 0.15 + headingCount * 80 - linkPenalty;
}

function bestArticle(
  candidates: (ExtractedArticle | undefined)[]
): ExtractedArticle | undefined {
  return candidates
    .filter((candidate): candidate is ExtractedArticle => Boolean(candidate?.text || candidate?.markdown || candidate?.excerpt))
    .sort((a, b) => articleQuality(b) - articleQuality(a))[0];
}

function extractArticle(
  source = getSource(),
  extractionSettings?: Partial<CaptureExtractionSettings>
): ExtractedArticle {
  const settings = normalizeExtractionSettings(extractionSettings);
  const host = location.hostname.toLowerCase();
  const siteSpecific = safeArticleExtraction(() =>
    siteExtractors.find((extractor) => extractor.matches(host))?.extract(source, settings)
  );
  const defuddle = safeArticleExtraction(() => extractDefuddle(source, settings));
  const readability = safeArticleExtraction(extractReadability);
  const fallback = settings.articleCleanupMode === "loose" || !readability || (readability.text?.length ?? 0) < MIN_FALLBACK_TEXT_LENGTH
    ? safeArticleExtraction(extractDensityFallback)
    : undefined;
  const candidates =
    settings.articleCleanupMode === "reader"
      ? [readability, defuddle, siteSpecific, fallback]
      : [defuddle, readability, siteSpecific, fallback];
  const best =
    settings.articleCleanupMode === "loose"
      ? bestArticle(candidates)
      : candidates.find((candidate) => (candidate?.text?.length ?? 0) >= 40 || Boolean(candidate?.markdown));

  return {
    title: best?.title,
    author: best?.author,
    publishedAt: best?.publishedAt,
    siteName: best?.siteName,
    text: best?.text ?? fallback?.text,
    markdown: best?.markdown ?? fallback?.markdown,
    html: best?.html ?? readability?.html ?? defuddle?.html,
    excerpt: best?.excerpt ?? pageDescription(),
    imageUrls: settings.includeImages ? best?.imageUrls ?? readability?.imageUrls ?? fallback?.imageUrls : undefined
  };
}

function sourceWithArticleMetadata(source: CaptureSource, article: ExtractedArticle): CaptureSource {
  return {
    ...source,
    title: article.title || source.title,
    siteName: article.siteName || source.siteName,
    author: article.author || source.author,
    publishedAt: article.publishedAt || source.publishedAt
  };
}

function safeArticleExtraction(extractor: () => ExtractedArticle | undefined): ExtractedArticle | undefined {
  try {
    return extractor();
  } catch {
    return undefined;
  }
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

function cssEscape(value: string): string {
  const css = (globalThis as typeof globalThis & { CSS?: { escape?: (input: string) => string } }).CSS;
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
}

function selectorForElement(element: Element): string {
  if (element.id) {
    return `#${cssEscape(element.id)}`;
  }

  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement && parts.length < 5) {
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }

    const currentTagName = current.tagName;
    const sameTagSiblings = [...parent.children].filter((child) => child.tagName === currentTagName);
    const index = sameTagSiblings.indexOf(current) + 1;
    parts.unshift(sameTagSiblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    current = parent;
  }

  return parts.join(" > ");
}

function captureFormState(source = getSource()): NonNullable<CaptureContext["formState"]> {
  const fields: PageFormFieldState[] = [];
  const elements = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement>(
    "input, textarea, select, [contenteditable]:not([contenteditable='false'])"
  );

  elements.forEach((element) => {
    if (
      !(element instanceof HTMLElement) ||
      (element instanceof HTMLInputElement && element.disabled) ||
      (element instanceof HTMLTextAreaElement && element.disabled) ||
      (element instanceof HTMLSelectElement && element.disabled) ||
      element.closest(`#${TOOLBAR_ID}`)
    ) {
      return;
    }

    const selector = selectorForElement(element);
    if (!selector) {
      return;
    }

    if (element instanceof HTMLInputElement) {
      if (["button", "file", "hidden", "image", "password", "reset", "submit"].includes(element.type)) {
        return;
      }

      fields.push({
        selector,
        tagName: "input",
        type: element.type,
        name: element.name || undefined,
        value: element.value,
        checked: ["checkbox", "radio"].includes(element.type) ? element.checked : undefined
      });
      return;
    }

    if (element instanceof HTMLTextAreaElement) {
      fields.push({
        selector,
        tagName: "textarea",
        name: element.name || undefined,
        value: element.value
      });
      return;
    }

    if (element instanceof HTMLSelectElement) {
      fields.push({
        selector,
        tagName: "select",
        name: element.name || undefined,
        value: element.value,
        selectedValues: [...element.selectedOptions].map((option) => option.value)
      });
      return;
    }

    if (element.isContentEditable) {
      fields.push({
        selector,
        tagName: element.tagName.toLowerCase(),
        value: element.innerHTML
      });
    }
  });

  return {
    url: source.url,
    title: source.title,
    savedAt: new Date().toISOString(),
    fields
  };
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

function isPrimaryVideoHost(): boolean {
  const host = location.hostname.toLowerCase();
  return hostMatches(host, ["youtube.com", "youtu.be", "vimeo.com", "x.com", "twitter.com"]);
}

function hasArticleLikeMainContent(): boolean {
  const root = extractionRoot([
    "article .available-content",
    "article .post-content",
    "article .body",
    "article",
    "main",
    "[role='main']"
  ]);
  const text = normalizeWhitespace(root?.innerText || root?.textContent || "");
  const paragraphCount = root?.querySelectorAll("p, li, blockquote, pre").length ?? 0;

  return text.length >= 700 && paragraphCount >= 2;
}

function hasSubstackArticleContent(): boolean {
  if (!isSubstackHost()) {
    return false;
  }

  const root = extractionRoot([
    "article .available-content",
    "article .post-content",
    "article .body",
    ".available-content",
    ".post-content",
    ".post-body",
    ".single-post",
    ".note-content",
    "[data-testid='post-content']",
    "[data-testid='note-content']",
    "article",
    "[role='article']",
    "main"
  ]);
  const text = normalizeWhitespace(root?.innerText || root?.textContent || "");
  const paragraphCount = root?.querySelectorAll("p, li, blockquote, pre").length ?? 0;

  return text.length >= 700 && paragraphCount >= 2;
}

function hasRedditPostContent(): boolean {
  if (!isRedditHost()) {
    return false;
  }

  const root = redditPostRoot();
  const title =
    redditAttribute(root, ["post-title", "data-title"]) ??
    redditTextFromSelectors(root ?? document, ["h1", "[slot='title']", "a.title", "[data-testid='post-title']"]);
  const body = root ? redditPostBody(root) : undefined;

  return Boolean(title || body);
}

function shouldWaitForArticleContent(kind: ContentExtractKind): boolean {
  return (isSubstackHost() || isRedditHost()) && (kind === "smart" || kind === "page" || kind === "page-state");
}

function hasSiteArticleContent(): boolean {
  if (isSubstackHost()) {
    return hasSubstackArticleContent();
  }

  if (isRedditHost()) {
    return hasRedditPostContent();
  }

  return true;
}

async function waitForSiteArticleContent(kind: ContentExtractKind): Promise<void> {
  if (!shouldWaitForArticleContent(kind) || hasSiteArticleContent()) {
    return;
  }

  const deadline = Date.now() + 1600;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    if (hasSiteArticleContent()) {
      return;
    }
  }
}

function isProminentVideo(video: HTMLVideoElement): boolean {
  const rect = video.getBoundingClientRect();
  const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
  const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
  const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);

  return rect.width >= 360 && rect.height >= 200 && visibleArea / viewportArea >= 0.18;
}

function hasVideoMoment(): boolean {
  const video = activeVideoElement();
  if (!video || !Number.isFinite(video.currentTime) || video.currentTime <= 0) {
    return false;
  }

  if (!isPrimaryVideoHost() && hasArticleLikeMainContent()) {
    return false;
  }

  return isPrimaryVideoHost() || isProminentVideo(video);
}

function isThreadLikePage(): boolean {
  const host = location.hostname.toLowerCase();
  return host === "twitter.com" || host === "x.com" || host.endsWith(".twitter.com") || host.endsWith(".x.com");
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
    : host === "twitter.com" || host === "x.com" || host.endsWith(".twitter.com") || host.endsWith(".x.com")
      ? "x"
      : host === "vimeo.com" || host.endsWith(".vimeo.com")
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

  const index = highlightFocusIndex % pageHighlights.length;
  const capture = pageHighlights[index];
  const element = document.querySelector<HTMLElement>(`[data-strix-capture-id="${capture.id}"]`);

  if (element) {
    document.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_ACTIVE_CLASS}`)
      .forEach((highlight) => highlight.classList.remove(HIGHLIGHT_ACTIVE_CLASS));
    element.classList.add(HIGHLIGHT_ACTIVE_CLASS);
    activeHighlightId = capture.id;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  highlightFocusIndex = (index + 1) % pageHighlights.length;
}

function extractDraft(message: Extract<ContentMessage, { type: "strix:extract" }>): CaptureDraft {
  const source = getSource();
  const selectionText = selectedText();
  const extractionSettings = normalizeExtractionSettings(message.extractionSettings);

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
        defaultDestination: message.defaultDestination,
        extractionSettings
      });
    }

    return extractDraft({
      type: "strix:extract",
      kind: "page",
      defaultDestination: message.defaultDestination,
      extractionSettings
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

  if (message.kind === "page-state") {
    const article = extractArticle(source, extractionSettings);
    const articleSource = sourceWithArticleMetadata(source, article);
    const formState = captureFormState(source);
    const fieldCount = formState.fields.length;

    return {
      kind: "page-state",
      source: articleSource,
      content: {
        ...article,
        selectionText,
        excerpt: `${fieldCount} entr${fieldCount === 1 ? "y" : "ies"} saved at this page position.`
      },
      context: {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        textQuote: selectionText,
        textFragment: textFragment(selectionText),
        pageKey: getPageKey(articleSource),
        viewport: getViewport(),
        formState
      },
      destination: destination(message.defaultDestination)
    };
  }

  const article = extractArticle(source, extractionSettings);
  const articleSource = sourceWithArticleMetadata(source, article);
  return {
    kind: "page",
    source: articleSource,
    content: {
      ...article,
      selectionText
    },
    context: {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      textQuote: selectionText,
      textFragment: textFragment(selectionText),
      pageKey: getPageKey(articleSource),
      viewport: getViewport()
    },
    destination: destination(message.defaultDestination)
  };
}

async function extractDraftAsync(message: Extract<ContentMessage, { type: "strix:extract" }>): Promise<CaptureDraft> {
  await waitForSiteArticleContent(message.kind);
  return extractDraft(message);
}

function fallbackDraftFromPage(
  message: Extract<ContentMessage, { type: "strix:extract" }>,
  source = getSource()
): CaptureDraft {
  const selectionText = selectedText();
  const text = normalizeWhitespace(document.body?.innerText || "");
  const kind: CaptureDraft["kind"] =
    message.kind === "smart"
      ? selectionText
        ? "selection"
        : "page"
      : message.kind;

  return {
    kind,
    source,
    content: {
      selectionText,
      text: text || source.title,
      markdown: text || (source.url ? `[${source.title ?? source.url}](${source.url})` : source.title),
      excerpt: pageDescription() ?? (text.slice(0, 280) || source.title)
    },
    context: {
      scrollX: window.scrollX,
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

  if (request.type === "strix:add-selection-highlight") {
    activateHighlightMode();
    saveHighlightFromSelection()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : "Unable to add highlight." }));
    return true;
  }

  if (request.type === "strix:clip-page-highlights") {
    clipHighlights()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : "Unable to clip highlights." }));
    return true;
  }

  if (request.type === "strix:deactivate-highlight-mode") {
    deactivateHighlightMode();
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "strix:play-clip-feedback") {
    playClipFeedback(request.kind);
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "strix:restore-context") {
    restoreContext(request.textQuote, request.scrollY, request.scrollX, request.formState);
    sendResponse({ success: true });
    return false;
  }

  if (request.type !== "strix:extract") {
    return false;
  }

  extractDraftAsync(request)
    .catch(() => fallbackDraftFromPage(request))
    .then(sendResponse);
  return true;
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
    "gap:4px",
    "padding:4px",
    "border:1px solid rgba(255,255,255,0.18)",
    "border-radius:999px",
    "background:rgba(37,37,38,0.96)",
    "box-shadow:0 8px 22px rgba(0,0,0,0.38)",
    "backdrop-filter:blur(12px)",
    "color:#f4efe7",
    "font:12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
  ].join(";");

  const clip = document.createElement("button");
  clip.type = "button";
  clip.id = "strix-highlight-clip";
  clip.textContent = "Clip highlights";
  clip.style.cssText = [
    "height:32px",
    "border:0",
    "border-radius:999px",
    "padding:0 12px",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "background:#8b5cf6",
    "color:#fff",
    "font:700 14px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "white-space:nowrap"
  ].join(";");
  clip.addEventListener("mousedown", (event) => event.preventDefault());
  clip.addEventListener("click", () => {
    clipHighlights().catch(() => undefined);
  });

  const count = document.createElement("button");
  count.type = "button";
  count.id = "strix-highlight-count";
  count.setAttribute("aria-label", "Jump to highlighted text");
  count.textContent = "0";
  count.style.cssText = [
    "min-width:32px",
    "height:32px",
    "border:0",
    "padding:0 10px",
    "border-radius:999px",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "background:rgba(255,255,255,0.10)",
    "color:#d7d7d8",
    "font:700 14px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
  ].join(";");
  count.addEventListener("mousedown", (event) => event.preventDefault());
  count.addEventListener("click", () => {
    jumpToHighlight();
  });

  const deleteButton = toolbarTextButton("strix-highlight-delete", "Delete selected highlight", "del");
  deleteButton.addEventListener("click", () => {
    deleteFocusedHighlight().catch(() => undefined);
  });

  const closeButton = toolbarTextButton("strix-highlight-close", "Close highlighter", "x");
  closeButton.addEventListener("click", () => {
    deactivateHighlightMode();
  });

  toolbar.append(clip);
  toolbar.append(count);
  toolbar.append(deleteButton);
  toolbar.append(closeButton);
  document.documentElement.append(toolbar);
  return toolbar;
}

function toolbarTextButton(id: string, label: string, text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = text;
  button.style.cssText = [
    "min-width:32px",
    "height:32px",
    "border:0",
    "border-radius:999px",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "padding:0 9px",
    "background:rgba(255,255,255,0.08)",
    "color:#d7d7d8",
    "font:700 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "text-transform:uppercase"
  ].join(";");
  button.addEventListener("mousedown", (event) => event.preventDefault());
  return button;
}

function updateToolbarPosition(): void {
  const toolbar = ensureToolbar();
  if (highlightModeActive || pageHighlights.length > 0) {
    const width = Math.min(320, Math.max(220, toolbar.getBoundingClientRect().width || 280));
    toolbar.style.left = `${Math.max(8, Math.round((window.innerWidth - width) / 2))}px`;
    toolbar.style.top = "10px";
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
    updateToolbarPosition();
    return;
  }

  const response = await sendRuntimeMessage<CreateCaptureResponse>({
    type: "captures:create",
    draft
  });

  playClipFeedback();
  restoreHighlight(response.capture);
  await refreshPageHighlights();
  window.getSelection()?.removeAllRanges();
  updateToolbarPosition();
}

async function clipHighlights(): Promise<void> {
  if (!pageHighlights.length) {
    updateToolbarPosition();
    return;
  }

  const source = getSource();
  const highlights = pageHighlights
    .map((capture) => capture.content.selectionText ?? capture.content.text ?? capture.context.textQuote)
    .map((text) => text?.trim())
    .filter(Boolean) as string[];

  if (!highlights.length) {
    return;
  }

  const markdown = highlights.map((text) => `> ${text.replace(/\n/g, "\n> ")}`).join("\n\n");
  const draft: CaptureDraft = {
    kind: "page",
    source,
    content: {
      text: highlights.join("\n\n"),
      markdown,
      excerpt: `${highlights.length} highlight${highlights.length === 1 ? "" : "s"} clipped from this page.`
    },
    context: {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pageKey: getPageKey(source),
      viewport: getViewport()
    }
  };

  await sendRuntimeMessage<CreateCaptureResponse>({
    type: "captures:create",
    draft
  });
  playClipFeedback("highlight");
  flashToolbarLabel("Clipped");
}

function flashToolbarLabel(label: string): void {
  const button = document.querySelector<HTMLButtonElement>("#strix-highlight-clip");
  if (!button) {
    return;
  }

  const previous = button.textContent ?? "Clip highlights";
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = previous;
  }, 1200);
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
  activeHighlightId = undefined;

  for (const capture of pageHighlights) {
    restoreHighlight(capture);
  }

  renderToolbarState();
  updateToolbarPosition();
}

function selectionFeedbackRects(): DOMRect[] {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return [];
  }

  const viewportPadding = 8;
  const rects: DOMRect[] = [];

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    for (const rect of [...range.getClientRects()]) {
      if (rect.width < 1 || rect.height < 1) {
        continue;
      }

      const visibleLeft = Math.max(viewportPadding, rect.left);
      const visibleTop = Math.max(viewportPadding, rect.top);
      const visibleRight = Math.min(window.innerWidth - viewportPadding, rect.right);
      const visibleBottom = Math.min(window.innerHeight - viewportPadding, rect.bottom);

      if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
        continue;
      }

      rects.push(new DOMRect(visibleLeft, visibleTop, visibleRight - visibleLeft, visibleBottom - visibleTop));
    }
  }

  return rects.slice(0, 12);
}

function clampFeedbackRect(rect: DOMRect, viewportPadding = 8): DOMRect | undefined {
  const left = Math.max(viewportPadding, rect.left);
  const top = Math.max(viewportPadding, rect.top);
  const right = Math.min(window.innerWidth - viewportPadding, rect.right);
  const bottom = Math.min(window.innerHeight - viewportPadding, rect.bottom);

  if (right <= left || bottom <= top) {
    return undefined;
  }

  return new DOMRect(left, top, right - left, bottom - top);
}

function elementFeedbackRects(): DOMRect[] {
  const selectors = [
    "article h1",
    "main h1",
    "[role='main'] h1",
    "h1",
    "article h2",
    "main h2",
    "article p",
    "main p",
    "article figure img",
    "main figure img"
  ];
  const rects: DOMRect[] = [];
  const seen = new Set<Element>();
  const maxWidth = window.innerWidth * 0.92;
  const maxHeight = Math.max(72, window.innerHeight * 0.28);

  for (const selector of selectors) {
    for (const element of [...document.querySelectorAll<HTMLElement>(selector)]) {
      if (seen.has(element)) {
        continue;
      }
      seen.add(element);

      const text = element.textContent?.trim();
      if (!(element instanceof HTMLImageElement) && (!text || text.length < 12)) {
        continue;
      }

      const rect = clampFeedbackRect(element.getBoundingClientRect(), 8);
      if (!rect || rect.width < 32 || rect.height < 12 || rect.width > maxWidth || rect.height > maxHeight) {
        continue;
      }

      rects.push(rect);
      if (rects.length >= 4) {
        return rects;
      }
    }
  }

  return rects;
}

function fallbackFeedbackRect(): DOMRect {
  const width = Math.max(160, window.innerWidth - 24);
  const height = Math.max(120, window.innerHeight - 24);
  return new DOMRect(
    12,
    12,
    width,
    height
  );
}

function clipFeedbackRects(kind?: CaptureDraft["kind"]): DOMRect[] {
  const selectionRects = selectionFeedbackRects();
  if (selectionRects.length > 0) {
    return selectionRects;
  }

  if (kind !== "selection" && kind !== "highlight") {
    const elementRects = elementFeedbackRects();
    if (elementRects.length > 0) {
      return elementRects;
    }
  }

  return [fallbackFeedbackRect()];
}

function playClipFeedbackForRects(rects: DOMRect[]): void {
  ensureClipFeedbackStyles();

  const fragment = document.createDocumentFragment();
  const outlines: HTMLDivElement[] = [];

  for (const rect of rects) {
    const outline = document.createElement("div");
    outline.className = CLIP_FEEDBACK_CLASS;
    outline.setAttribute("aria-hidden", "true");
    outline.style.left = `${rect.left}px`;
    outline.style.top = `${rect.top}px`;
    outline.style.width = `${rect.width}px`;
    outline.style.height = `${rect.height}px`;
    outlines.push(outline);
    fragment.append(outline);
  }

  document.documentElement.append(fragment);
  window.setTimeout(() => outlines.forEach((outline) => outline.remove()), 190);
}

function playClipFeedback(kind?: CaptureDraft["kind"]): void {
  playClipFeedbackForRects(clipFeedbackRects(kind));
}

function ensureClipFeedbackStyles(): void {
  if (document.getElementById(CLIP_FEEDBACK_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = CLIP_FEEDBACK_STYLE_ID;
  style.textContent = `
    .${CLIP_FEEDBACK_CLASS} {
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      box-sizing: border-box;
      border: 1px solid rgba(116, 124, 138, 0.82);
      border-radius: 3px;
      opacity: 0;
      transform: scale(1.05);
      transform-origin: center;
      animation: strixClipOutline 180ms cubic-bezier(0.2, 0, 0, 1) forwards;
      contain: layout style paint;
    }

    @keyframes strixClipOutline {
      0% { opacity: 0; transform: scale(1.05); }
      20% { opacity: 0.78; }
      70% { opacity: 0.78; transform: scale(1); }
      100% { opacity: 0; transform: scale(1); }
    }

    @media (prefers-reduced-motion: reduce) {
      .${CLIP_FEEDBACK_CLASS} {
        animation-duration: 90ms;
      }
    }
  `;
  document.documentElement.append(style);
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
  const element = document.querySelector<HTMLElement>(`[data-strix-capture-id="${capture.id}"]`);
  if (element) {
    bindHighlightElement(element, capture.id);
  }
}

function bindHighlightElement(element: HTMLElement, captureId: string): void {
  if (element.dataset.strixBound === "true") {
    return;
  }

  element.dataset.strixBound = "true";
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    document.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_ACTIVE_CLASS}`)
      .forEach((highlight) => highlight.classList.remove(HIGHLIGHT_ACTIVE_CLASS));
    element.classList.add(HIGHLIGHT_ACTIVE_CLASS);
    activeHighlightId = captureId;
    highlightFocusIndex = Math.max(0, pageHighlights.findIndex((highlight) => highlight.id === captureId));
    renderToolbarState();
  });
}

function renderToolbarState(): void {
  const toolbar = document.getElementById(TOOLBAR_ID);
  if (!toolbar) {
    return;
  }

  toolbar.style.display = (highlightModeActive || pageHighlights.length > 0) ? "flex" : "none";

  const count = toolbar.querySelector<HTMLButtonElement>("#strix-highlight-count");
  if (count) {
    count.textContent = String(pageHighlights.length);
    count.disabled = pageHighlights.length === 0;
  }

  const clip = toolbar.querySelector<HTMLButtonElement>("#strix-highlight-clip");
  if (clip) {
    clip.disabled = pageHighlights.length === 0;
    clip.style.opacity = pageHighlights.length === 0 ? "0.56" : "1";
  }

  const deleteButton = toolbar.querySelector<HTMLButtonElement>("#strix-highlight-delete");
  if (deleteButton) {
    deleteButton.disabled = pageHighlights.length === 0;
    deleteButton.style.opacity = pageHighlights.length === 0 ? "0.45" : "1";
  }
}

async function deleteFocusedHighlight(): Promise<void> {
  if (!pageHighlights.length) {
    return;
  }

  const active = activeHighlightId
    ? pageHighlights.find((highlight) => highlight.id === activeHighlightId)
    : undefined;
  const index = active ? pageHighlights.indexOf(active) : Math.max(0, Math.min(highlightFocusIndex - 1, pageHighlights.length - 1));
  await deleteHighlight(active ?? pageHighlights[index]);
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
  activeHighlightId = undefined;
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

function deactivateHighlightMode(): void {
  highlightModeActive = false;
  document.documentElement.classList.remove(HIGHLIGHT_MODE_CLASS);
  window.getSelection()?.removeAllRanges();
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
      background: rgba(255, 230, 109, 0.72);
      border-radius: 2px;
      box-shadow: inset 0 -0.12em 0 rgba(255, 207, 45, 0.72);
      padding: 0;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }

    .${HIGHLIGHT_CLASS}:hover,
    .${HIGHLIGHT_CLASS}.${HIGHLIGHT_ACTIVE_CLASS} {
      background: rgba(255, 221, 72, 0.86);
      box-shadow: inset 0 -0.14em 0 rgba(255, 191, 0, 0.84);
    }

    .${HIGHLIGHT_MODE_CLASS},
    .${HIGHLIGHT_MODE_CLASS} body,
    .${HIGHLIGHT_MODE_CLASS} body * {
      cursor: text !important;
    }

    #${TOOLBAR_ID},
    #${TOOLBAR_ID} * {
      cursor: default !important;
    }
  `;
  document.documentElement.append(style);
}

function wrapFirstTextMatch(quote: string, captureId: string): boolean {
  const textNodes: Text[] = [];
  let fullText = "";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(`#${TOOLBAR_ID}, .${HIGHLIGHT_CLASS}`)) {
        return NodeFilter.FILTER_REJECT;
      }

      if (["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "NOSCRIPT"].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }

      return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });

  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    fullText += node.textContent ?? "";
    node = walker.nextNode();
  }

  const match = textMatchOffsets(fullText, quote);
  if (!match) {
    return false;
  }

  const start = textPositionFromGlobalOffset(textNodes, match.start);
  const end = textPositionFromGlobalOffset(textNodes, match.end);
  if (!start || !end) {
    return false;
  }

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);

  const mark = document.createElement("span");
  mark.className = HIGHLIGHT_CLASS;
  mark.dataset.strixCaptureId = captureId;

  try {
    mark.append(range.extractContents());
    range.insertNode(mark);
    bindHighlightElement(mark, captureId);
    return true;
  } catch {
    return false;
  }
}

function textMatchOffsets(fullText: string, quote: string): { start: number; end: number } | undefined {
  const exactIndex = fullText.indexOf(quote);
  if (exactIndex >= 0) {
    return { start: exactIndex, end: exactIndex + quote.length };
  }

  const normalized = normalizeTextWithOffsets(fullText);
  const normalizedQuote = normalizeWhitespace(quote);
  const normalizedIndex = normalized.text.indexOf(normalizedQuote);
  if (normalizedIndex < 0) {
    return undefined;
  }

  const start = normalized.offsets[normalizedIndex];
  const lastIndex = normalizedIndex + normalizedQuote.length - 1;
  const end = (normalized.offsets[lastIndex] ?? start) + 1;
  return { start, end };
}

function normalizeTextWithOffsets(input: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  let pendingSpaceOffset: number | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (/\s/.test(character)) {
      pendingSpaceOffset ??= index;
      continue;
    }

    if (pendingSpaceOffset !== undefined && text.length > 0) {
      text += " ";
      offsets.push(pendingSpaceOffset);
    }

    text += character;
    offsets.push(index);
    pendingSpaceOffset = undefined;
  }

  return { text, offsets };
}

function textPositionFromGlobalOffset(
  nodes: Text[],
  targetOffset: number
): { node: Text; offset: number } | undefined {
  let cursor = 0;

  for (const node of nodes) {
    const length = node.textContent?.length ?? 0;
    if (targetOffset <= cursor + length) {
      return {
        node,
        offset: Math.max(0, targetOffset - cursor)
      };
    }
    cursor += length;
  }

  const last = nodes[nodes.length - 1];
  return last ? { node: last, offset: last.textContent?.length ?? 0 } : undefined;
}

function restoreFormState(formState?: CaptureContext["formState"]): void {
  if (!formState) {
    return;
  }

  for (const field of formState.fields) {
    const element = document.querySelector(field.selector);
    if (!element) {
      continue;
    }

    if (element instanceof HTMLInputElement) {
      if (field.checked !== undefined) {
        setNativeInputChecked(element, field.checked);
      }
      if (field.value !== undefined && element.type !== "checkbox" && element.type !== "radio") {
        setNativeInputValue(element, field.value);
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      continue;
    }

    if (element instanceof HTMLTextAreaElement && field.value !== undefined) {
      setNativeTextAreaValue(element, field.value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      continue;
    }

    if (element instanceof HTMLSelectElement) {
      const selectedValues = new Set(field.selectedValues ?? (field.value ? [field.value] : []));
      [...element.options].forEach((option) => {
        option.selected = selectedValues.has(option.value);
      });
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      continue;
    }

    if (element instanceof HTMLElement && element.isContentEditable && field.value !== undefined) {
      element.innerHTML = field.value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    }
  }
}

function setNativeInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
}

function setNativeInputChecked(element: HTMLInputElement, checked: boolean): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
  if (setter) {
    setter.call(element, checked);
  } else {
    element.checked = checked;
  }
}

function setNativeTextAreaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
}

function restoreScrollPosition(scrollY?: number, scrollX?: number): void {
  if (scrollY === undefined && scrollX === undefined) {
    return;
  }

  window.scrollTo({
    left: scrollX ?? window.scrollX,
    top: scrollY ?? window.scrollY,
    behavior: "smooth"
  });
}

function restoreContext(
  textQuote?: string,
  scrollY?: number,
  scrollX?: number,
  formState?: CaptureContext["formState"]
): void {
  window.setTimeout(() => {
    restoreFormState(formState);

    if (textQuote) {
      const restored = [...document.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_CLASS}`)]
        .find((element) => element.textContent?.trim() === textQuote.trim());
      if (restored) {
        restored.scrollIntoView({ block: "center" });
        return;
      }
    }

    restoreScrollPosition(scrollY, scrollX);
  }, 200);

  if (formState) {
    window.setTimeout(() => {
      restoreFormState(formState);
      restoreScrollPosition(scrollY, scrollX);
    }, 750);
    window.setTimeout(() => {
      restoreFormState(formState);
      restoreScrollPosition(scrollY, scrollX);
    }, 1500);
  }
}

function removeLegacyDropTarget(): void {
  document.getElementById("strix-black-hole-drop")?.remove();
  document.getElementById("strix-black-hole-style")?.remove();
}

document.addEventListener("mouseup", (event) => {
  if (event.target instanceof Element && event.target.closest(`#${TOOLBAR_ID}`)) {
    return;
  }
  window.setTimeout(() => {
    queueAutoHighlight();
  }, 0);
});
document.addEventListener("keyup", () => window.setTimeout(() => {
  queueAutoHighlight();
}, 0));
document.addEventListener("scroll", () => window.setTimeout(updateToolbarPosition, 0), { passive: true });

removeLegacyDropTarget();
ensureHighlightStyles();
refreshPageHighlights().catch(() => undefined);
