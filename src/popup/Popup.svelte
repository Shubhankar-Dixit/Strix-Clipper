<script lang="ts">
  import browser from "webextension-polyfill";
  import type {
    ContentExtractKind,
    CreateCaptureResponse,
    ListCapturesResponse,
    SettingsResponse,
    StatsResponse,
    SyncResponse
  } from "../lib/messages";
  import { captureToMarkdown } from "../lib/markdown";
  import { extractionSettingsFrom } from "../lib/settings";
  import type {
    CaptureDraft,
    CaptureRecord,
    CaptureStats,
    StrixClipperSettings
  } from "../types/capture";

  type ActiveTab = {
    id: number;
    title?: string;
    url?: string;
  };

  let captures: CaptureRecord[] = [];
  let stats: CaptureStats = {
    total: 0,
    local: 0,
    pending: 0,
    synced: 0,
    error: 0
  };
  let settings: StrixClipperSettings = {
    apiBaseUrl: "",
    apiToken: "",
    defaultDestination: "library",
    defaultCaptureMode: "smart",
    articleCleanupMode: "smart",
    includeImages: true,
    includeReplies: false,
    preferredLanguage: ""
  };
  let status = "Ready";
  let busy = false;
  let showSettings = false;
  let currentTab: ActiveTab | undefined;
  let pageDraft: CaptureDraft | undefined;
  let hostname = "";
  let editTitle = "";
  let editUrl = "";
  let editDescription = "";
  let editSiteName = "";
  let editAuthor = "";
  let editPublishedAt = "";
  let editCapturedAt = "";
  let editCanonicalUrl = "";
  let confirmDeleteId = "";
  let selectedBox = "Inbox";
  let boxes = ["Inbox", "Moodboard", "Ideas", "Research", "Music"];
  let customFolder = "";
  let captureMode: ContentExtractKind = "smart";
  let editTimestamp = "";

  function getBoxSymbol(box: string) {
    switch (box) {
      case "Inbox": return "○";
      case "Moodboard": return "◇";
      case "Ideas": return "✶";
      case "Research": return "⌁";
      case "Music": return "♪";
      case "Custom": return "+";
      default: return "○";
    }
  }

  async function sendMessage<T>(message: unknown): Promise<T> {
    return (await browser.runtime.sendMessage(message)) as T;
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

    if (!scriptingBrowser.scripting) {
      throw new Error("Highlight mode is not ready on this page. Reload the extension and refresh the tab.");
    }

    await scriptingBrowser.scripting.executeScript({
      target: { tabId },
      files: ["assets/content.js"]
    });
  }

  async function sendContentMessage<T>(tabId: number, message: unknown): Promise<T> {
    try {
      return (await browser.tabs.sendMessage(tabId, message)) as T;
    } catch (error) {
      if (!isMissingContentScriptError(error)) {
        throw error;
      }

      await injectContentScript(tabId);
      return (await browser.tabs.sendMessage(tabId, message)) as T;
    }
  }

  async function playClipFeedback(kind: CaptureDraft["kind"]) {
    if (!currentTab?.id) {
      return;
    }

    await sendContentMessage(currentTab.id, {
      type: "strix:play-clip-feedback",
      kind
    }).catch(() => undefined);
  }

  function destination(target?: StrixClipperSettings["defaultDestination"]) {
    return target ? { target } : undefined;
  }

  function formatTimestamp(seconds?: number): string {
    const rounded = Math.max(0, Math.floor(seconds ?? 0));
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const remaining = rounded % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
    }

    return `${minutes}:${String(remaining).padStart(2, "0")}`;
  }

  function parseTimestamp(value: string): number | undefined {
    const parts = value.trim().split(":").map((part) => Number(part));
    if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) {
      return undefined;
    }

    if (parts.length === 1) {
      return parts[0];
    }

    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }

    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    return undefined;
  }

  function urlWithTimestamp(url: string, seconds: number): string {
    try {
      const parsed = new URL(url);
      const rounded = String(Math.max(0, Math.floor(seconds)));

      if (parsed.hostname.includes("youtube.com") || parsed.hostname === "youtu.be") {
        parsed.searchParams.set("t", rounded);
      } else {
        parsed.hash = `t=${rounded}`;
      }

      return parsed.toString();
    } catch {
      return url;
    }
  }

  function applyDraftToEditor(draft: CaptureDraft) {
    editTitle = draft.source.title || currentTab?.title || "";
    editUrl = draft.source.url || currentTab?.url || "";
    editDescription = draft.content.excerpt || "";
    editSiteName = draft.source.siteName || hostname || "";
    editAuthor = draft.source.author || "";
    editPublishedAt = draft.source.publishedAt || "";
    editCapturedAt = draft.source.capturedAt || "";
    editCanonicalUrl = draft.source.canonicalUrl || "";
    editTimestamp = draft.context.video ? formatTimestamp(draft.context.video.timestampSeconds) : "";
  }

  async function activeTab(): Promise<ActiveTab> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab is available.");
    }
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url
    };
  }

  async function load() {
    currentTab = await activeTab().catch(() => undefined);
    hostname = "";
    if (currentTab?.url) {
      try {
        hostname = new URL(currentTab.url).hostname;
      } catch {
        hostname = currentTab.url;
      }
    }

    const [listResponse, statsResponse, settingsResponse] = await Promise.all([
      sendMessage<ListCapturesResponse>({ type: "captures:list", limit: 25 }),
      sendMessage<StatsResponse>({ type: "captures:stats" }),
      sendMessage<SettingsResponse>({ type: "settings:get" })
    ]);

    captures = listResponse.captures;
    stats = statsResponse.stats;
    settings = settingsResponse.settings;
    captureMode = settings.defaultCaptureMode;
    try {
      pageDraft = await extract(captureMode);
      applyDraftToEditor(pageDraft);
    } catch {
      editTitle = currentTab?.title || "";
      editUrl = currentTab?.url || "";
      editSiteName = hostname;
      editAuthor = "";
      editPublishedAt = "";
      editCapturedAt = "";
      editCanonicalUrl = "";
      editTimestamp = "";
    }
  }

  async function extract(kind: ContentExtractKind): Promise<CaptureDraft> {
    const tab = await activeTab();
    try {
      return await sendContentMessage<CaptureDraft>(tab.id, {
        type: "strix:extract",
        kind,
        defaultDestination: settings.defaultDestination,
        extractionSettings: extractionSettingsFrom(settings)
      });
    } catch {
      const capturedAt = new Date().toISOString();
      const fallbackKind: CaptureDraft["kind"] = kind === "smart" ? "page" : kind;
      return {
        kind: fallbackKind,
        source: {
          url: tab.url ?? "",
          title: tab.title,
          capturedAt
        },
        content: {
          markdown: tab.url ? `[${tab.title ?? tab.url}](${tab.url})` : tab.title,
          text: tab.title
        },
        context: {},
        destination: destination(settings.defaultDestination)
      };
    }
  }

  function applyEdits(draft: CaptureDraft): CaptureDraft {
    const markdown = draft.content.markdown ?? draft.content.selectionText ?? draft.content.text ?? "";
    const customTag = selectedBox === "Custom" ? [] : [selectedBox];
    const folderId = selectedBox === "Custom" ? customFolder.trim() || undefined : undefined;
    const editedTimestamp =
      draft.context.video && editTimestamp.trim()
        ? parseTimestamp(editTimestamp)
        : undefined;
    const sourceUrl =
      draft.context.video && editedTimestamp !== undefined
        ? urlWithTimestamp(editUrl.trim() || draft.source.url, editedTimestamp)
        : editUrl.trim() || draft.source.url;
    const videoMarkdown =
      draft.context.video && editedTimestamp !== undefined
        ? `[${editTitle.trim() || draft.source.title || "Video moment"} @ ${formatTimestamp(editedTimestamp)}](${sourceUrl})`
        : markdown;

    return {
      ...draft,
      source: {
        ...draft.source,
        title: editTitle.trim() || draft.source.title,
        url: sourceUrl,
        canonicalUrl: editCanonicalUrl.trim() || draft.source.canonicalUrl,
        siteName: editSiteName.trim() || draft.source.siteName,
        author: editAuthor.trim() || draft.source.author,
        publishedAt: editPublishedAt.trim() || draft.source.publishedAt,
        capturedAt: editCapturedAt.trim() || draft.source.capturedAt
      },
      content: {
        ...draft.content,
        excerpt: editDescription.trim() || draft.content.excerpt,
        markdown: editDescription.trim() ? `> [!abstract] Note\n> ${editDescription.trim()}\n\n${videoMarkdown}` : videoMarkdown
      },
      context: {
        ...draft.context,
        video:
          draft.context.video && editedTimestamp !== undefined
            ? {
                ...draft.context.video,
                timestampSeconds: editedTimestamp
              }
            : draft.context.video
      },
      destination: {
        target: settings.defaultDestination,
        folderId,
        tags: customTag.filter(Boolean) as string[]
      }
    };
  }

  async function actuallyDelete(captureId: string) {
    try {
      await sendMessage({ type: "captures:delete", captureId });
      captures = captures.filter((c) => c.id !== captureId);
      confirmDeleteId = "";
      if (currentTab?.id) {
        await sendContentMessage(currentTab.id, { type: "strix:refresh-highlights" }).catch(() => undefined);
      }
    } catch (e) {
      status = "Unable to delete related item.";
    }
  }

  async function commitCapture() {
    if (selectedBox === "Custom" && !customFolder.trim()) {
      status = "Type a folder name for Save as.";
      return;
    }

    busy = true;
    status = "Saving draft...";
    try {
      const draft = applyEdits(pageDraft ?? (await extract(captureMode)));
      if (draft.context.video && editTimestamp.trim() && parseTimestamp(editTimestamp) === undefined) {
        status = "Use a timestamp like 1:23 or 01:02:03.";
        return;
      }

      if (draft.kind === "selection" && !draft.content.selectionText?.trim()) {
        status = "Select page text before saving a selection.";
        return;
      }

      const response = await sendMessage<CreateCaptureResponse>({
        type: "captures:create",
        draft
      });
      await playClipFeedback(draft.kind);
      status = `Saved ${response.capture.kind}.`;
      await load();
    } catch (error) {
      status = error instanceof Error ? error.message : "Capture failed.";
    } finally {
      busy = false;
    }
  }

  async function savePageState() {
    busy = true;
    status = "Saving position...";
    try {
      const draft = applyEdits(await extract("page-state"));
      const response = await sendMessage<CreateCaptureResponse>({
        type: "captures:create",
        draft
      });
      await playClipFeedback(draft.kind);
      const fieldCount = response.capture.context.formState?.fields.length ?? 0;
      status = `Saved position${fieldCount ? ` with ${fieldCount} entries` : ""}.`;
      await load();
    } catch (error) {
      status = error instanceof Error ? error.message : "Position save failed.";
    } finally {
      busy = false;
    }
  }

  async function save(kind: ContentExtractKind) {
    busy = true;
    status = "Capturing...";
    try {
      const draft = await extract(kind);
      if ((kind === "selection" || kind === "highlight") && !draft.content.selectionText?.trim()) {
        status = "Select page text before saving a selection.";
        return;
      }

      const response = await sendMessage<CreateCaptureResponse>({
        type: "captures:create",
        draft
      });
      await playClipFeedback(draft.kind);
      status = `Saved ${response.capture.kind}.`;
      await load();
    } catch (error) {
      status = error instanceof Error ? error.message : "Capture failed.";
    } finally {
      busy = false;
    }
  }

  async function activateHighlightMode() {
    captureMode = "highlight";
    busy = true;
    status = "Opening highlight mode...";
    try {
      const tab = await activeTab();
      if (!tab.id || (tab.url && (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:")))) {
        throw new Error("Cannot highlight on browser setup pages.");
      }

      await sendContentMessage(tab.id, {
        type: "strix:activate-highlight-mode"
      });

      window.close();
    } catch (error) {
      busy = false;
      status = error instanceof Error ? error.message : "Unable to open highlight mode.";
    }
  }

  async function copyMarkdown() {
    busy = true;
    status = "Preparing Markdown...";
    try {
      const draft = await extract("page");
      const response = await sendMessage<CreateCaptureResponse>({
        type: "captures:create",
        draft
      });
      await playClipFeedback(draft.kind);
      await navigator.clipboard.writeText(captureToMarkdown(response.capture));
      status = "Saved and copied Markdown.";
      await load();
    } catch (error) {
      status = error instanceof Error ? error.message : "Copy failed.";
    } finally {
      busy = false;
    }
  }

  async function sync() {
    busy = true;
    status = "Syncing...";
    try {
      const response = await sendMessage<SyncResponse>({ type: "captures:sync" });
      status = response.message;
      await load();
    } catch (error) {
      status = error instanceof Error ? error.message : "Sync failed.";
    } finally {
      busy = false;
    }
  }

  async function openCapture(capture: CaptureRecord) {
    busy = true;
    status = "Opening capture...";
    try {
      await sendMessage({ type: "captures:open", captureId: capture.id });
      window.close();
    } catch (error) {
      status = error instanceof Error ? error.message : "Unable to open capture.";
    } finally {
      busy = false;
    }
  }

  function toggleSettings() {
    showSettings = !showSettings;
    status = showSettings ? "Settings" : "Ready";
  }

  async function saveSettings() {
    busy = true;
    status = "Saving settings...";
    try {
      const response = await sendMessage<SettingsResponse>({
        type: "settings:set",
        settings
      });
      settings = response.settings;
      status = "Settings saved.";
    } catch (error) {
      status = error instanceof Error ? error.message : "Unable to save settings.";
    } finally {
      busy = false;
    }
  }

  async function exportJson() {
    busy = true;
    status = "Exporting...";
    try {
      const response = await sendMessage<ListCapturesResponse>({
        type: "captures:list"
      });
      const blob = new Blob([JSON.stringify(response.captures, null, 2)], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `strix-clips-${new Date().toISOString()}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      status = `Exported ${response.captures.length} capture${response.captures.length === 1 ? "" : "s"}.`;
    } catch (error) {
      status = error instanceof Error ? error.message : "Export failed.";
    } finally {
      busy = false;
    }
  }

  async function clearLocalData() {
    if (!confirm("Clear all local Strix Clipper captures?")) {
      return;
    }

    busy = true;
    status = "Clearing...";
    try {
      await sendMessage({ type: "captures:clear" });
      captures = [];
      if (currentTab?.id) {
        await sendContentMessage(currentTab.id, { type: "strix:refresh-highlights" }).catch(() => undefined);
      }
      status = "Local captures cleared.";
      await load();
    } catch (error) {
      status = error instanceof Error ? error.message : "Clear failed.";
    } finally {
      busy = false;
    }
  }

  async function setCaptureMode(mode: ContentExtractKind) {
    captureMode = mode;
    busy = true;
    status = `Extracting ${mode}...`;
    try {
      pageDraft = await extract(mode);
      applyDraftToEditor(pageDraft);
      status = "Ready";
    } catch {
      status = `Failed to extract ${mode}.`;
    } finally {
      busy = false;
    }
  }

  function captureTitle(capture: CaptureRecord): string {
    return capture.source.title || capture.content.selectionText || capture.source.url;
  }

  function normalizePageKey(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }

    try {
      const url = new URL(value);
      url.hash = "";
      return url.toString();
    } catch {
      return value.split("#")[0];
    }
  }

  function savedPositionCaptures(): CaptureRecord[] {
    const currentKeys = new Set(
      [
        currentTab?.url,
        pageDraft?.source.url,
        pageDraft?.source.canonicalUrl,
        pageDraft?.context.pageKey
      ]
        .map((value) => normalizePageKey(value))
        .filter(Boolean)
    );

    return captures
      .filter((capture) => {
        if (capture.kind !== "page-state") {
          return false;
        }

        if (currentKeys.size === 0) {
          return true;
        }

        return [
          capture.source.url,
          capture.source.canonicalUrl,
          capture.context.pageKey,
          capture.context.formState?.url
        ]
          .map((value) => normalizePageKey(value))
          .some((key) => key && currentKeys.has(key));
      })
      .slice(0, 4);
  }

  function savedPositionMeta(capture: CaptureRecord): string {
    const fields = capture.context.formState?.fields.length ?? 0;
    const savedAt = formatDate(capture.context.formState?.savedAt ?? capture.createdAt);
    const fieldLabel = `${fields} entr${fields === 1 ? "y" : "ies"}`;
    return savedAt ? `${savedAt} · ${fieldLabel}` : fieldLabel;
  }

  function captureKindLabel(kind?: string): string {
    switch (kind) {
      case "video-moment": return "Video moment";
      case "thread": return "Thread";
      case "selection": return "Selection";
      case "bookmark": return "Bookmark";
      case "highlight": return "Highlight";
      case "page-state": return "Page position";
      case "page": return "Page";
      default: return "Smart clip";
    }
  }

  function compactUrl(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  function formatDate(value?: string): string {
    if (!value) {
      return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  function contentPreview(): string {
    return (
      pageDraft?.content.selectionText ??
      pageDraft?.content.markdown ??
      pageDraft?.content.text ??
      pageDraft?.content.excerpt ??
      ""
    ).trim();
  }

  function sourceLinks(): { label: string; value: string }[] {
    const links: { label: string; value: string }[] = [];

    if (editUrl.trim()) {
      links.push({ label: "Source", value: editUrl.trim() });
    }

    if (editCanonicalUrl.trim() && editCanonicalUrl.trim() !== editUrl.trim()) {
      links.push({ label: "Canonical", value: editCanonicalUrl.trim() });
    }

    if (pageDraft?.context.threadUrl && pageDraft.context.threadUrl !== editUrl.trim()) {
      links.push({ label: "Thread", value: pageDraft.context.threadUrl });
    }

    return links;
  }

  function embedItems(): { label: string; value: string }[] {
    const embeds: { label: string; value: string }[] = [];

    if (pageDraft?.context.video) {
      embeds.push({
        label: pageDraft.context.video.provider,
        value: `Timestamp ${formatTimestamp(pageDraft.context.video.timestampSeconds)}`
      });
    }

    if (pageDraft?.context.imageUrl) {
      embeds.push({ label: "Image", value: pageDraft.context.imageUrl });
    }

    pageDraft?.content.imageUrls?.forEach((url, index) => {
      if (url !== pageDraft?.context.imageUrl) {
        embeds.push({ label: `Image ${index + 1}`, value: url });
      }
    });

    return embeds;
  }

  load().catch((error) => {
    status = error instanceof Error ? error.message : "Unable to load captures.";
  });
</script>

<main class="board-layout">
  <header class="header">
    <div class="header-title">STRIX CLIPPER</div>
    <div class="header-right">
      <div class="mode-switcher" aria-label="Capture mode">
        <button class="mode-btn smart-mode-btn {captureMode === 'smart' ? 'active' : ''}" disabled={busy} onclick={() => setCaptureMode("smart")} aria-label="Smart clip" title="Smart Clip">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.75v3.5M12 16.75v3.5M20.25 12h-3.5M7.25 12h-3.5" />
            <path d="m17.85 6.15-2.5 2.5M8.65 15.35l-2.5 2.5M17.85 17.85l-2.5-2.5M8.65 8.65l-2.5-2.5" />
            <path d="M12 8.75a3.25 3.25 0 1 1 0 6.5 3.25 3.25 0 0 1 0-6.5z" />
          </svg>
          <span>Smart</span>
        </button>
        <button class="mode-btn highlight-mode-btn {captureMode === 'highlight' ? 'active' : ''}" disabled={busy} onclick={activateHighlightMode} aria-label="Highlight mode" title="Highlight">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5.25 15.75 9.9-9.9 3 3-9.9 9.9h-3z" />
            <path d="m13.7 7.3 1.45-1.45 3 3-1.45 1.45" />
            <path d="M4.75 20h8.5" />
          </svg>
        </button>
      </div>
      <button
        class="utility-btn icon-btn"
        disabled={busy}
        onclick={toggleSettings}
        aria-label={showSettings ? "Close settings" : "Settings"}
        title={showSettings ? "Close settings" : "Settings"}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z" />
          <path d="M4.5 12h2.1m10.8 0h2.1M12 4.5v2.1m0 10.8v2.1" />
          <path d="m6.7 6.7 1.5 1.5m7.6 7.6 1.5 1.5M17.8 6.7l-1.5 1.5m-7.6 7.6-1.5 1.5" />
        </svg>
      </button>
    </div>
  </header>

  {#if showSettings}
    <div class="sections settings-view">
      <div class="board-section">
        <div class="section-label">CONNECTION</div>
        <div class="settings-form">
          <label>
            API Base URL
            <input
              bind:value={settings.apiBaseUrl}
              placeholder="https://strix.example.com"
              autocomplete="off"
            />
          </label>
          <label>
            API Token
            <input
              bind:value={settings.apiToken}
              type="password"
              placeholder="Paste a Strix clipper token"
              autocomplete="off"
            />
          </label>
        </div>
      </div>

      <div class="board-section">
        <div class="section-label">CAPTURE</div>
        <div class="settings-form compact-settings">
          <label>
            Default Clip
            <select bind:value={settings.defaultCaptureMode}>
              <option value="smart">Smart</option>
              <option value="page">Page</option>
              <option value="selection">Selection</option>
              <option value="bookmark">Bookmark</option>
            </select>
          </label>
          <label>
            Article Cleanup
            <select bind:value={settings.articleCleanupMode}>
              <option value="smart">Smart clean</option>
              <option value="reader">Reader strict</option>
              <option value="loose">Loose capture</option>
            </select>
          </label>
          <label>
            Language
            <input bind:value={settings.preferredLanguage} placeholder="auto or en" autocomplete="off" />
          </label>
          <label class="checkbox-setting">
            <input type="checkbox" bind:checked={settings.includeImages} />
            <span>Keep images</span>
          </label>
          <label class="checkbox-setting">
            <input type="checkbox" bind:checked={settings.includeReplies} />
            <span>Include replies</span>
          </label>
        </div>
      </div>

      <div class="board-section">
        <div class="section-label">LOCAL DATA</div>
        <div class="settings-actions">
          <button class="extract-btn" disabled={busy} onclick={saveSettings}><span class="bracket">[</span>Save Settings<span class="bracket">]</span></button>
          <button class="extract-btn" disabled={busy} onclick={sync}><span class="bracket">[</span>Retry Sync<span class="bracket">]</span></button>
          <button class="extract-btn" disabled={busy} onclick={exportJson}><span class="bracket">[</span>Export JSON<span class="bracket">]</span></button>
          <button class="extract-btn danger" disabled={busy} onclick={clearLocalData}><span class="bracket">[</span>Clear Local<span class="bracket">]</span></button>
        </div>
      </div>
    </div>
  {:else}
  <div class="sections clip-layout">
    <div class="board-section title-section">
      <div class="section-label">Title</div>
      <input bind:value={editTitle} class="title-field" placeholder="Untitled clip" spellcheck="false" />
      <div class="meta-grid">
        <label class="meta-chip">
          <span>Site</span>
          <input bind:value={editSiteName} placeholder="Site" spellcheck="false" />
        </label>
        <label class="meta-chip">
          <span>Author</span>
          <input bind:value={editAuthor} placeholder="Author" spellcheck="false" />
        </label>
        <label class="meta-chip">
          <span>Published</span>
          <input bind:value={editPublishedAt} placeholder="Published" spellcheck="false" />
        </label>
        <label class="meta-chip">
          <span>Captured</span>
          <input bind:value={editCapturedAt} placeholder="Captured" spellcheck="false" />
        </label>
        <label class="meta-chip wide-meta-chip">
          <span>URL</span>
          <input bind:value={editUrl} placeholder="Source URL" spellcheck="false" />
        </label>
        <label class="meta-chip wide-meta-chip">
          <span>Canonical</span>
          <input bind:value={editCanonicalUrl} placeholder="Canonical URL" spellcheck="false" />
        </label>
      </div>
    </div>

    <div class="board-section">
      <div class="section-label">Description</div>
      <textarea bind:value={editDescription} rows="3" class="annotation-field" placeholder="Add context or summary..."></textarea>
    </div>

    <div class="board-section">
      <div class="section-label">Content</div>
      <div class="content-preview">
        {#if contentPreview()}
          {contentPreview()}
        {:else}
          <span class="empty">No extracted content yet.</span>
        {/if}
      </div>
    </div>

    <div class="section-grid">
      <div class="board-section">
        <div class="section-label">Links</div>
        <div class="link-list">
          {#each sourceLinks() as link}
            <label>
              <span>{link.label}</span>
              <input value={link.value} readonly spellcheck="false" />
            </label>
          {/each}
          {#if sourceLinks().length === 0}
            <p class="empty">No links found.</p>
          {/if}
        </div>
      </div>

      <div class="board-section">
        <div class="section-label">Embeds</div>
        <div class="embed-list">
          {#if pageDraft?.context.video}
            <input bind:value={editTimestamp} class="timestamp-input embed-timestamp" placeholder="Timestamp" spellcheck="false" />
          {/if}
          {#each embedItems() as embed}
            <div class="embed-row">
              <span>{embed.label}</span>
              <strong>{embed.value}</strong>
            </div>
          {/each}
          {#if embedItems().length === 0}
            <p class="empty">No embeddable media.</p>
          {/if}
        </div>
      </div>
    </div>

    <div class="board-section">
      <div class="section-label">Organize</div>
      <div class="section-content save-as-stack">
        <div class="nest-boxes">
          {#each boxes as box}
            <button
              class="nest-btn {selectedBox === box ? 'active' : ''}"
              disabled={busy}
              onclick={() => (selectedBox = box)}
            >
              <span class="symbol">{box === 'Inbox' && selectedBox === box ? '●' : getBoxSymbol(box)}</span>
              <span class="box-text">{box}</span>
            </button>
          {/each}
          <button
            class="nest-btn {selectedBox === 'Custom' ? 'active' : ''}"
            disabled={busy}
            onclick={() => (selectedBox = 'Custom')}
          >
            <span class="symbol">+</span>
            <span class="box-text">Folder</span>
          </button>
        </div>
        {#if selectedBox === 'Custom'}
          <div class="custom-folder-row">
            <input
              bind:value={customFolder}
              class="folder-input inline-folder-input"
              autocomplete="off"
              placeholder="Folder name"
              spellcheck="false"
            />
            <div class="folder-help">Type a folder name for this clip.</div>
          </div>
        {/if}
      </div>
    </div>

    <div class="board-section positions-section">
      <div class="section-label">Saved Positions</div>
      <div class="recent-list positions-list">
        {#if savedPositionCaptures().length === 0}
          <p class="empty">No saved positions for this page.</p>
        {:else}
          {#each savedPositionCaptures() as capture}
            <div class="related-item position-item">
              <button class="related-btn position-btn" disabled={busy} onclick={() => openCapture(capture)}>
                <span>{captureTitle(capture)}</span>
                <strong>{savedPositionMeta(capture)}</strong>
              </button>
              <div class="related-actions">
                {#if confirmDeleteId === capture.id}
                  <button class="action-btn confirm-btn" aria-label="Confirm" onclick={() => actuallyDelete(capture.id)}>✓</button>
                  <button class="action-btn cancel-btn" aria-label="Cancel" onclick={() => (confirmDeleteId = "")}>✗</button>
                {:else}
                  <button class="action-btn delete-trigger" aria-label="Delete" onclick={() => (confirmDeleteId = capture.id)}>✕</button>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </div>

  </div>
  {/if}

  <footer class="footer">
    {#if showSettings}
      <button class="utility-btn" disabled={busy} onclick={toggleSettings}>Back</button>
      <button class="utility-btn" disabled={busy} onclick={saveSettings}>Save Settings</button>
      <span class="footer-status">{status}</span>
    {:else}
      <button class="save-position-btn" disabled={busy} onclick={savePageState}>
        Save Position
      </button>
      <button class="add-btn" disabled={busy} onclick={commitCapture}>
        {status === "Ready" ? "Add to Strix ↵" : status}
      </button>
    {/if}
  </footer>
</main>

<style>
  :global(html),
  :global(body),
  :global(#app) {
    width: var(--popup-width) !important;
    max-width: var(--popup-width) !important;
    height: auto !important;
    min-height: 300px;
    max-height: 600px !important;
    overflow: hidden !important;
    scrollbar-width: none;
    overscroll-behavior: none;
  }

  :global(html::-webkit-scrollbar),
  :global(body::-webkit-scrollbar) {
    display: none;
  }

  .board-layout {
    display: flex;
    flex-direction: column;
    padding: 16px 16px;
    background: var(--bg);
    width: var(--popup-width);
    height: auto;
    min-height: 300px;
    max-height: 600px;
    overflow: hidden;
    font-family: var(--font-sans);
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
    padding-bottom: 12px;
    margin-bottom: 8px;
  }

  .header-title {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1px;
    color: var(--text-main);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .mode-switcher {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.02);
  }

  .mode-btn {
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--text-muted);
    min-width: 28px;
    height: 28px;
    padding: 0 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 600;
    transition: background-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
  }

  .mode-btn svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .mode-btn:hover:not(:disabled),
  .mode-btn.active {
    background: var(--bg-panel);
    color: var(--text-main);
  }

  .timestamp-input {
    color: var(--accent-yellow);
  }

  .highlight-mode-btn.active,
  .highlight-mode-btn:hover:not(:disabled) {
    color: var(--accent-yellow);
    box-shadow: inset 0 0 0 1px rgba(176, 148, 79, 0.35);
  }

  .sections {
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
    padding-bottom: 14px;
    scrollbar-color: var(--border-focus) transparent;
    scrollbar-width: thin;
  }

  .board-section {
    padding: 12px 0;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: transparent;
    flex: 0 0 auto;
  }

  .board-section:last-child {
    border-bottom: none;
  }

  .clip-layout {
    overflow-x: hidden;
  }

  .section-label {
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.5px;
    color: var(--text-dim);
    text-transform: capitalize;
  }

  .section-content {
    display: flex;
    flex-direction: column;
  }

  .save-as-stack {
    gap: 8px;
  }

  .nest-boxes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .custom-folder-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .title-section {
    gap: 14px;
    padding-bottom: 8px;
  }

  .title-field {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text-main);
    font-family: inherit;
    font-size: 16px;
    font-weight: 500;
    line-height: 1.3;
    outline: none;
    padding: 0;
  }

  .meta-grid {
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 8px;
    padding-bottom: 4px;
    scrollbar-width: none;
  }
  .meta-grid::-webkit-scrollbar {
    display: none;
  }

  .meta-chip {
    flex: 0 0 auto;
    border: none;
    border-radius: var(--radius-sm);
    background: rgba(255, 255, 255, 0.04);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    transition: background 0.2s ease;
  }

  .wide-meta-chip {
    flex: 0 0 auto;
  }

  .embed-row,
  .link-list label {
    min-width: 0;
    border-radius: var(--radius-sm);
    background: rgba(255, 255, 255, 0.04);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .embed-row span,
  .link-list span {
    color: var(--text-dim);
    font-size: 10px;
    font-family: var(--font-mono);
    line-height: 1;
    margin-bottom: 0;
    text-transform: uppercase;
  }

  .meta-chip span {
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1;
    margin-bottom: 0;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .meta-chip input {
    width: auto;
    min-width: 60px;
    background: transparent;
    border: none;
    color: var(--text-main);
    font-size: 11px;
    outline: none;
    padding: 0;
  }

  .meta-chip:focus-within {
    background: rgba(255, 255, 255, 0.08);
  }

  .embed-row strong {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
  }

  .meta-chip input {
    min-width: 0;
    width: 100%;
    overflow: hidden;
    border: none;
    background: transparent;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    line-height: 1.25;
    outline: none;
    padding: 0;
  }

  .meta-chip:focus-within {
    border-color: var(--border-focus);
  }

  .meta-chip input::placeholder {
    color: var(--text-dim);
  }

  .annotation-field {
    min-height: 62px;
    max-height: 150px;
    width: 100%;
    background: transparent;
    border: none;
    border-left: 2px solid rgba(255, 255, 255, 0.1);
    border-radius: 0;
    color: var(--text-main);
    font-family: inherit;
    font-size: 13px;
    line-height: 1.45;
    outline: none;
    padding: 2px 8px;
    resize: vertical;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .annotation-field:focus {
    border-left-color: var(--border-focus);
  }

  .content-preview {
    max-height: 150px;
    overflow-y: auto;
    border-left: 2px solid var(--border-focus);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.45;
    padding: 2px 0 2px 9px;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .section-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.75fr);
    gap: 12px;
    align-items: start;
  }

  .link-list,
  .embed-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    max-height: 118px;
    overflow-y: auto;
    padding-right: 4px;
    scrollbar-color: var(--border-focus) transparent;
    scrollbar-width: thin;
  }

  .link-list::-webkit-scrollbar,
  .embed-list::-webkit-scrollbar {
    width: 4px;
  }

  .link-list::-webkit-scrollbar-thumb,
  .embed-list::-webkit-scrollbar-thumb {
    background: var(--border-focus);
    border-radius: 999px;
  }

  .link-list input {
    width: 100%;
    overflow: hidden;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    outline: none;
    padding: 0;
    text-overflow: ellipsis;
  }

  .embed-timestamp {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: rgba(0, 0, 0, 0.14);
    font-family: var(--font-mono);
    font-size: 11px;
    outline: none;
    padding: 7px 8px;
  }

  .folder-input {
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-focus);
    color: var(--text-main);
    font-family: inherit;
    font-size: 13px;
    padding: 2px 4px;
    width: 100%;
    outline: none;
  }

  .folder-input:focus {
    border-bottom-color: var(--accent-cream);
  }

  .inline-folder-input {
    padding-left: 0;
  }

  .folder-help {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
  }

  .nest-btn,
  .related-btn,
  .extract-btn,
  .utility-btn {
    background: transparent;
    border: none;
    padding: 4px 0;
    font-size: 13px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
    transition: color 0.2s;
  }

  .nest-btn:hover:not(:disabled),
  .related-btn:hover:not(:disabled),
  .extract-btn:hover:not(:disabled),
  .utility-btn:hover:not(:disabled),
  .nest-btn.active {
    color: var(--accent-cream);
  }

  .nest-btn {
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 5px 10px;
    background: rgba(255, 255, 255, 0.02);
  }

  .nest-btn.active {
    border-color: var(--border-focus);
  }

  .icon-btn {
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    background: rgba(255, 255, 255, 0.03);
  }

  .icon-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .danger:hover:not(:disabled) {
    color: #d77;
  }

  .bracket {
    color: var(--border-focus);
    font-family: var(--font-mono);
  }

  .symbol {
    font-family: var(--font-mono);
    display: inline-block;
    width: 14px;
    text-align: center;
  }

  .settings-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .settings-form label {
    color: var(--text-muted);
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
  }

  .settings-form input,
  .settings-form select {
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-main);
    font-size: 13px;
    outline: none;
    padding: 0 0 8px 0;
  }

  .settings-form select {
    color-scheme: dark;
  }

  .settings-form input:focus,
  .settings-form select:focus {
    border-bottom-color: var(--border-focus);
  }

  .compact-settings {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .compact-settings label:not(.checkbox-setting):nth-child(3) {
    grid-column: 1 / -1;
  }

  .checkbox-setting {
    align-items: center;
    flex-direction: row !important;
    gap: 8px !important;
    text-transform: none !important;
  }

  .checkbox-setting input {
    accent-color: var(--border-focus);
    border: none;
    padding: 0;
    width: 14px;
  }

  .checkbox-setting span {
    color: var(--text-muted);
  }

  .settings-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }

  .settings-view {
    flex: 1;
  }

  .positions-section {
    gap: 8px;
  }

  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-height: 0;
    max-height: none;
    overflow-y: auto;
    padding-right: 4px;
    scrollbar-color: var(--border-focus) transparent;
    scrollbar-width: thin;
  }

  .related-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 4px;
    border-radius: 4px;
    transition: background 0.15s;
  }

  .related-item:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .related-actions {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .action-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 11px;
    padding: 2px;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }

  .delete-trigger {
    opacity: 0;
  }

  .related-item:hover .delete-trigger {
    opacity: 1;
  }

  .delete-trigger:hover,
  .cancel-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-main);
  }

  .confirm-btn:hover {
    background: rgba(124, 92, 255, 0.2);
    color: #a48dfa;
  }

  .recent-list::-webkit-scrollbar {
    width: 4px;
  }

  .recent-list::-webkit-scrollbar-thumb {
    background: var(--border-focus);
    border-radius: 999px;
  }

  .empty {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
  }

  .empty {
    margin: 0;
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 16px;
    flex: 0 0 auto;
    margin-top: 8px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }

  .add-btn,
  .save-position-btn,
  .footer-status {
    background: transparent;
    border: none;
    color: var(--text-main);
    font-size: 13px;
    font-weight: 500;
    padding: 4px 0;
    transition: color 0.2s;
    max-width: 190px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .footer-status {
    color: var(--text-muted);
    font-weight: 400;
    margin-left: auto;
    padding: 4px 0;
  }

  .add-btn:hover:not(:disabled) {
    color: var(--accent-cream);
  }

  .positions-list {
    max-height: 96px;
  }

  .position-btn {
    min-width: 0;
    flex: 1;
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
    padding: 3px 0;
    text-align: left;
  }

  .position-btn span,
  .position-btn strong {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .position-btn strong {
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
  }

  .save-position-btn:hover:not(:disabled) {
    color: var(--accent-cream);
  }

  .save-position-btn {
    margin-right: auto;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
