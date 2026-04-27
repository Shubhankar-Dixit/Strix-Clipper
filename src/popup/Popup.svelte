<script lang="ts">
  import browser from "webextension-polyfill";
  import type {
    CreateCaptureResponse,
    ListCapturesResponse,
    SettingsResponse,
    StatsResponse,
    SyncResponse
  } from "../lib/messages";
  import { captureToMarkdown } from "../lib/markdown";
  import type {
    CaptureDestinationTarget,
    CaptureDraft,
    CaptureRecord,
    CaptureStats,
    StrixClipperSettings
  } from "../types/capture";

  const destinations: CaptureDestinationTarget[] = [
    "strix-captures",
    "note",
    "memory",
    "canvas"
  ];

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
    defaultDestination: "strix-captures"
  };
  let status = "Ready";
  let busy = false;
  let showSettings = false;
  let currentTab: ActiveTab | undefined;
  let pageDraft: CaptureDraft | undefined;
  let hostname = "";
  let editTitle = "";
  let meaningText = "A web resource useful for reading or reference later.";
  let selectedBox = "Inbox";
  let boxes = ["Inbox", "Moodboard", "Ideas", "Research", "Music"];
  let captureMode: "page" | "selection" | "bookmark" = "page";

  async function sendMessage<T>(message: unknown): Promise<T> {
    return (await browser.runtime.sendMessage(message)) as T;
  }

  function destination(target?: StrixClipperSettings["defaultDestination"]) {
    return target ? { target } : undefined;
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

    try {
      pageDraft = await extract(captureMode);
      editTitle = pageDraft.source.title || currentTab?.title || "";
    } catch {
      editTitle = currentTab?.title || "";
    }
  }

  async function extract(kind: "page" | "selection" | "bookmark"): Promise<CaptureDraft> {
    const tab = await activeTab();
    try {
      return (await browser.tabs.sendMessage(tab.id, {
        type: "strix:extract",
        kind,
        defaultDestination: settings.defaultDestination
      })) as CaptureDraft;
    } catch {
      const capturedAt = new Date().toISOString();
      return {
        kind,
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
    const meaning = meaningText.trim();

    return {
      ...draft,
      source: {
        ...draft.source,
        title: editTitle.trim() || draft.source.title
      },
      content: {
        ...draft.content,
        markdown: meaning ? `> [!abstract] Meaning\n> ${meaning}\n\n${markdown}` : markdown
      },
      destination: {
        target: settings.defaultDestination || "strix-captures",
        tags: selectedBox ? [selectedBox] : undefined
      }
    };
  }

  async function commitCapture() {
    busy = true;
    status = "Saving draft...";
    try {
      const draft = applyEdits(pageDraft ?? (await extract(captureMode)));
      if (captureMode === "selection" && !draft.content.selectionText?.trim()) {
        status = "Select page text before saving a selection.";
        return;
      }

      const response = await sendMessage<CreateCaptureResponse>({
        type: "captures:create",
        draft
      });
      status = `Saved ${response.capture.kind}.`;
      await load();
    } catch (error) {
      status = error instanceof Error ? error.message : "Capture failed.";
    } finally {
      busy = false;
    }
  }

  async function save(kind: "page" | "selection" | "bookmark") {
    busy = true;
    status = "Capturing...";
    try {
      const draft = await extract(kind);
      if (kind === "selection" && !draft.content.selectionText?.trim()) {
        status = "Select page text before saving a selection.";
        return;
      }

      const response = await sendMessage<CreateCaptureResponse>({
        type: "captures:create",
        draft
      });
      status = `Saved ${response.capture.kind}.`;
      await load();
    } catch (error) {
      status = error instanceof Error ? error.message : "Capture failed.";
    } finally {
      busy = false;
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
      anchor.download = `strix-captures-${new Date().toISOString()}.json`;
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
      status = "Local captures cleared.";
      await load();
    } catch (error) {
      status = error instanceof Error ? error.message : "Clear failed.";
    } finally {
      busy = false;
    }
  }

  async function setCaptureMode(mode: "page" | "selection" | "bookmark") {
    captureMode = mode;
    busy = true;
    status = `Extracting ${mode}...`;
    try {
      pageDraft = await extract(mode);
      editTitle = pageDraft.source.title || currentTab?.title || "";
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

  function compactUrl(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  load().catch((error) => {
    status = error instanceof Error ? error.message : "Unable to load captures.";
  });
</script>

<main class="board-layout">
  <header class="header">
    <div class="header-tools">
      <button
        class="tool-btn {captureMode === 'page' ? 'active' : ''}"
        disabled={busy}
        onclick={() => setCaptureMode("page")}
        title="Capture Page"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      </button>
      <button
        class="tool-btn {captureMode === 'selection' ? 'active' : ''}"
        disabled={busy}
        onclick={() => setCaptureMode("selection")}
        title="Capture Selection"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
      </button>
      <button
        class="tool-btn {captureMode === 'bookmark' ? 'active' : ''}"
        disabled={busy}
        onclick={() => setCaptureMode("bookmark")}
        title="Capture Bookmark"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
      </button>
    </div>

    <div class="header-right">
      <div class="shortcut">⌘K</div>
      <div class="mini-count" title="Total captures">{stats.total}</div>
      <button class="icon-btn {showSettings ? 'active' : ''}" disabled={busy} onclick={toggleSettings} title="Settings">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
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
          <label>
            Default Destination
            <select bind:value={settings.defaultDestination}>
              {#each destinations as destination}
                <option value={destination}>{destination}</option>
              {/each}
            </select>
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
  <div class="sections">
    <div class="board-section">
      <div class="section-label">SOURCE</div>
      <div class="section-content">
        <textarea bind:value={editTitle} rows="1" class="source-title-input" placeholder="Title..."></textarea>
        <div class="source-url">{hostname || "No host"}</div>
      </div>
    </div>

    <div class="board-section">
      <div class="section-label">MEANING</div>
      <div class="section-content">
        <textarea bind:value={meaningText} rows="2" class="meaning-input" placeholder="Why is this worth saving?"></textarea>
      </div>
    </div>

    <div class="board-section">
      <div class="section-label">SAVE INTO</div>
      <div class="section-content boxes">
        {#each boxes as box}
          <button
            class="box-btn {selectedBox === box ? 'active' : ''}"
            disabled={busy}
            onclick={() => (selectedBox = box)}
          >
            <span class="dot {box.toLowerCase()}"></span>
            <span class="bracket">[</span><span class="box-text">{box}</span><span class="bracket">]</span>
          </button>
        {/each}
      </div>
    </div>

    <div class="board-section">
      <div class="section-label">EXTRACT</div>
      <div class="section-content extract-boxes">
        <button class="extract-btn" disabled={busy} onclick={() => save("page")}><span class="bracket">[</span>Page<span class="bracket">]</span></button>
        <button class="extract-btn" disabled={busy} onclick={() => save("selection")}><span class="bracket">[</span>Quote<span class="bracket">]</span></button>
        <button class="extract-btn" disabled={busy} onclick={() => save("bookmark")}><span class="bracket">[</span>Bookmark<span class="bracket">]</span></button>
      </div>
    </div>

    <div class="board-section recent-section">
      <div class="recent-heading">
        <div class="section-label">RECENT</div>
        <div class="inline-stats">
          <span>{stats.local} local</span>
          <span>{stats.error} error</span>
        </div>
      </div>
      <div class="recent-list">
        {#if captures.length === 0}
          <p class="empty">No captures yet.</p>
        {:else}
          {#each captures as capture}
            <article class="capture-row">
              <button class="capture-main" disabled={busy} onclick={() => openCapture(capture)} title="Open where I left off">
                <span class="capture-title">{captureTitle(capture)}</span>
                <span class="capture-meta">{capture.kind} / {compactUrl(capture.source.url)} / {capture.sync.status}</span>
              </button>
              <button class="open-btn" disabled={busy} onclick={() => openCapture(capture)}>Open</button>
            </article>
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
      <div class="footer-stats">
        <span>{stats.pending} pending</span>
        <span>{stats.synced} synced</span>
      </div>
      <button class="utility-btn" disabled={busy} onclick={copyMarkdown}>Copy Markdown</button>
      <button class="utility-btn" disabled={busy} onclick={sync}>Sync</button>
      <button class="add-btn" disabled={busy} onclick={commitCapture}>
        {status === "Ready" ? "Add to Strix →" : status}
      </button>
    {/if}
  </footer>
</main>

<style>
  .board-layout {
    display: flex;
    flex-direction: column;
    padding: 16px 20px;
    background: var(--bg);
    min-height: 560px;
    height: auto;
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

  .header-tools {
    display: flex;
    gap: 8px;
  }

  .tool-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 4px;
    transition: all 0.2s;
  }

  .tool-btn:hover:not(:disabled) {
    color: var(--text-main);
    background: var(--bg-card);
  }

  .tool-btn.active {
    color: var(--accent-cream);
    background: var(--bg-panel);
    border: 1px solid var(--border);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .icon-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border-radius: 4px;
    transition: all 0.2s;
  }

  .icon-btn:hover:not(:disabled) {
    color: var(--text-main);
    background: var(--bg-card);
  }

  .icon-btn.active {
    color: var(--accent-cream);
    background: var(--bg-panel);
  }

  .shortcut,
  .mini-count {
    color: var(--border-focus);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .mini-count {
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-muted);
    min-width: 20px;
    padding: 2px 6px;
    text-align: center;
  }

  .sections {
    display: flex;
    flex-direction: column;
    gap: 0;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .board-section {
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 1px;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .section-content {
    display: flex;
    flex-direction: column;
  }

  .source-title-input {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--accent-cream);
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.4;
    resize: none;
    padding: 0;
    margin-bottom: 4px;
    overflow: hidden;
  }

  .source-title-input:focus {
    outline: none;
  }

  .source-url {
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .meaning-input {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text-main);
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    resize: none;
    padding: 0;
  }

  .meaning-input:focus {
    outline: none;
  }

  .boxes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .box-btn,
  .extract-btn,
  .utility-btn,
  .open-btn {
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

  .box-btn:hover:not(:disabled),
  .extract-btn:hover:not(:disabled),
  .utility-btn:hover:not(:disabled),
  .open-btn:hover:not(:disabled),
  .box-btn.active {
    color: var(--accent-cream);
  }

  .danger:hover:not(:disabled) {
    color: #d77;
  }

  .bracket {
    color: var(--border-focus);
    font-family: var(--font-mono);
    transition: opacity 0.2s, color 0.2s;
    opacity: 0;
  }

  .box-btn:hover .bracket,
  .box-btn.active .bracket,
  .extract-btn:hover .bracket {
    opacity: 1;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border-focus);
  }

  .dot.music { background: var(--accent-blue); }
  .dot.moodboard { background: var(--accent-cream); }
  .dot.ideas { background: var(--accent-yellow); }
  .dot.research { background: var(--accent-green); }
  .dot.inbox { background: var(--text-muted); }

  .extract-boxes {
    display: flex;
    gap: 16px;
    flex-direction: row;
    flex-wrap: wrap;
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

  .settings-form input:focus,
  .settings-form select:focus {
    border-bottom-color: var(--border-focus);
  }

  .settings-form option {
    background: var(--bg);
    color: var(--text-main);
  }

  .settings-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }

  .settings-view {
    flex: 1;
  }

  .recent-section {
    flex: 1;
    gap: 10px;
    min-height: 0;
  }

  .recent-heading {
    align-items: center;
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .inline-stats,
  .footer-stats {
    display: flex;
    gap: 10px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
  }

  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-height: 0;
    max-height: none;
    overflow-y: auto;
    padding-right: 4px;
    scrollbar-color: var(--border-focus) transparent;
    scrollbar-width: thin;
  }

  .recent-list::-webkit-scrollbar {
    width: 4px;
  }

  .recent-list::-webkit-scrollbar-thumb {
    background: var(--border-focus);
    border-radius: 999px;
  }

  .capture-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
  }

  .capture-main {
    min-width: 0;
    background: transparent;
    border: none;
    padding: 0;
    text-align: left;
  }

  .capture-main:hover:not(:disabled) .capture-title {
    color: var(--accent-cream);
  }

  .capture-title {
    display: block;
    overflow: hidden;
    color: var(--text-main);
    font-size: 12px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .capture-meta,
  .empty {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
  }

  .capture-meta {
    display: block;
    margin-top: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    margin: 0;
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 16px;
    margin-top: 8px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  .footer-stats {
    margin-right: auto;
  }

  .add-btn,
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

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
