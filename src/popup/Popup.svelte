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
  let editUrl = "";
  let editDescription = "";
  let confirmDeleteId = "";
  let selectedBox = "Inbox";
  let boxes = ["Inbox", "Moodboard", "Ideas", "Research", "Music"];
  let customFolder = "";
  let captureMode: "page" | "selection" | "highlight" | "bookmark" = "page";

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
      editUrl = pageDraft.source.url || currentTab?.url || "";
      editDescription = pageDraft.content.excerpt || "";
    } catch {
      editTitle = currentTab?.title || "";
      editUrl = currentTab?.url || "";
    }
  }

  async function extract(kind: "page" | "selection" | "highlight" | "bookmark"): Promise<CaptureDraft> {
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
    const customTag = selectedBox === "Custom" ? [] : [selectedBox];
    const folderId = selectedBox === "Custom" ? customFolder.trim() || undefined : undefined;

    return {
      ...draft,
      source: {
        ...draft.source,
        title: editTitle.trim() || draft.source.title,
        url: editUrl.trim() || draft.source.url
      },
      content: {
        ...draft.content,
        excerpt: editDescription.trim() || draft.content.excerpt,
        markdown: editDescription.trim() ? `> [!abstract] Note\n> ${editDescription.trim()}\n\n${markdown}` : markdown
      },
      destination: {
        target: settings.defaultDestination || "strix-captures",
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
      if ((captureMode === "selection" || captureMode === "highlight") && !draft.content.selectionText?.trim()) {
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

  async function save(kind: "page" | "selection" | "highlight" | "bookmark") {
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

  async function setCaptureMode(mode: "page" | "selection" | "highlight" | "bookmark") {
    captureMode = mode;
    busy = true;
    status = `Extracting ${mode}...`;
    try {
      pageDraft = await extract(mode);
      editTitle = pageDraft.source.title || currentTab?.title || "";
      editUrl = pageDraft.source.url || currentTab?.url || "";
      editDescription = pageDraft.content.excerpt || "";
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
    <div class="header-title">STRIX CLIPPER</div>
    <div class="header-right">
      <div class="mode-switcher" aria-label="Capture mode">
        <button class="mode-btn {captureMode === 'page' ? 'active' : ''}" disabled={busy} onclick={() => setCaptureMode("page")} aria-label="Page capture" title="Page">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 3.75h7.1L18 7.65v12.6H7z" />
            <path d="M14 3.75v4h4" />
            <path d="M9.75 11h5.5M9.75 14h5.5M9.75 17h3" />
          </svg>
        </button>
        <button class="mode-btn {captureMode === 'selection' ? 'active' : ''}" disabled={busy} onclick={() => setCaptureMode("selection")} aria-label="Selection capture" title="Selection">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6.25 7.25V5.5h1.75M16 5.5h1.75v1.75M17.75 16.75v1.75H16M8 18.5H6.25v-1.75" />
            <path d="M9.25 9.5h5.5M9.25 12h4.5M9.25 14.5h6" />
          </svg>
        </button>
        <button class="mode-btn {captureMode === 'bookmark' ? 'active' : ''}" disabled={busy} onclick={() => setCaptureMode("bookmark")} aria-label="Bookmark capture" title="Bookmark">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7.5 4.5h9v15l-4.5-3-4.5 3z" />
            <path d="M9.75 7.5h4.5" />
          </svg>
        </button>
        <button class="mode-btn highlight-mode-btn {captureMode === 'highlight' ? 'active' : ''}" disabled={busy} onclick={activateHighlightMode} aria-label="Highlight mode" title="Highlight">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5.25 15.75 9.9-9.9 3 3-9.9 9.9h-3z" />
            <path d="m13.7 7.3 1.45-1.45 3 3-1.45 1.45" />
            <path d="M4.75 20h8.5" />
          </svg>
        </button>
      </div>
      <button class="utility-btn" disabled={busy} onclick={toggleSettings}>{showSettings ? "Close" : "Settings"}</button>
      <div class="shortcut">⌘K</div>
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
      <div class="section-content source-dense">
        <input bind:value={editTitle} class="dense-input font-bold" placeholder="Title" spellcheck="false" />
        <input bind:value={editUrl} class="dense-input text-gray" placeholder="URL" spellcheck="false" />
        <textarea bind:value={editDescription} rows="2" class="dense-input" placeholder="Clip note or description..."></textarea>
      </div>
    </div>

    <div class="board-section">
      <div class="section-label">SAVE AS</div>
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

    <div class="board-section related-section">
      <div class="section-label">RELATED</div>
      <div class="recent-list">
        {#if captures.length === 0}
          <p class="empty">No related items.</p>
        {:else}
          {#each captures.slice(0, 3) as capture}
            <div class="related-item">
              <button class="related-btn list-btn" disabled={busy} onclick={() => openCapture(capture)}>
                {captureTitle(capture)}
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
      <button class="add-btn" disabled={busy} onclick={commitCapture}>
        {status === "Ready" ? "Add to Strix ↵" : status}
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
    min-height: 340px;
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
    width: 28px;
    height: 28px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
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

  .highlight-mode-btn.active,
  .highlight-mode-btn:hover:not(:disabled) {
    color: var(--accent-yellow);
    box-shadow: inset 0 0 0 1px rgba(176, 148, 79, 0.35);
  }

  .shortcut {
    color: var(--border-focus);
    font-family: var(--font-mono);
    font-size: 11px;
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
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 4px;
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

  .source-dense {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 6px;
    border: 1px solid var(--border);
  }

  .dense-input {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text-main);
    font-family: inherit;
    font-size: 13px;
    padding: 2px 0;
    outline: none;
    resize: none;
  }

  .font-bold {
    font-weight: 500;
  }

  .text-gray {
    color: var(--text-muted);
    font-size: 11px;
    font-family: var(--font-mono);
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

  .related-section {
    flex: 1;
    gap: 10px;
    min-height: 0;
    border-bottom: none;
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

  .list-btn {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 0;
    font-size: 12px;
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
    margin-top: 8px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
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
