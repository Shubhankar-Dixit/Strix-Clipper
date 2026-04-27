<script lang="ts">
  import browser from "webextension-polyfill";
  import type {
    CreateCaptureResponse,
    ListCapturesResponse,
    SettingsResponse,
    StatsResponse,
    SyncResponse
  } from "../lib/messages";
  import type {
    CaptureDraft,
    CaptureRecord,
    CaptureStats,
    StrixClipperSettings
  } from "../types/capture";
  import { captureToMarkdown } from "../lib/markdown";

  let captures: CaptureRecord[] = [];
  let stats: CaptureStats = {
    total: 0,
    local: 0,
    pending: 0,
    synced: 0,
    error: 0
  };
  let settings: StrixClipperSettings | undefined;
  let status = "Ready";
  let busy = false;
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

  type ActiveTab = {
    id: number;
    title?: string;
    url?: string;
  };

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
    if (currentTab?.url) {
      try {
        hostname = new URL(currentTab.url).hostname;
      } catch (e) {
        // ignore
      }
    }

    const [listResponse, statsResponse, settingsResponse] = await Promise.all([
      sendMessage<ListCapturesResponse>({ type: "captures:list", limit: 3 }),
      sendMessage<StatsResponse>({ type: "captures:stats" }),
      sendMessage<SettingsResponse>({ type: "settings:get" })
    ]);

    captures = listResponse.captures;
    stats = statsResponse.stats;
    settings = settingsResponse.settings;

    try {
      pageDraft = await extract("page");
      editTitle = pageDraft.source?.title || currentTab?.title || "";
    } catch (e) {
      editTitle = currentTab?.title || "";
    }
  }

  async function commitCapture() {
    busy = true;
    status = "Saving draft...";
    try {
      if (!pageDraft) {
        pageDraft = await extract(captureMode);
      }
      
      // Update draft with our manual edits before sending to Strix
      pageDraft.source.title = editTitle;
      
      if (meaningText.trim()) {
        const meaningBlock = `> [!abstract] Meaning\n> ${meaningText.trim()}\n\n`;
        pageDraft.content.markdown = meaningBlock + (pageDraft.content.markdown || "");
      }
      
      pageDraft.destination = {
        target: settings?.defaultDestination || "strix-captures",
        tags: [selectedBox]
      };
      const response = await sendMessage<CreateCaptureResponse>({
        type: "captures:create",
        draft: pageDraft
      });
      status = `Saved ${response.capture.kind}.`;
      await load();
      setTimeout(() => window.close(), 1200);
    } catch (error) {
      status = error instanceof Error ? error.message : "Capture failed.";
    } finally {
      busy = false;
    }
  }

  async function extract(kind: "page" | "selection" | "bookmark"): Promise<CaptureDraft> {
    const tab = await activeTab();
    try {
      return (await browser.tabs.sendMessage(tab.id!, {
        type: "strix:extract",
        kind,
        defaultDestination: settings?.defaultDestination
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
        destination: destination(settings?.defaultDestination)
      };
    }
  }

  async function save(kind: "page" | "selection" | "bookmark") {
    busy = true;
    status = "Capturing...";
    try {
      const draft = await extract(kind);
      if (kind === "selection" && !draft.content.selectionText) {
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

  function openOptions() {
    browser.runtime.openOptionsPage();
  }

  async function setCaptureMode(mode: "page" | "selection" | "bookmark") {
    captureMode = mode;
    busy = true;
    status = `Extracting ${mode}...`;
    try {
      pageDraft = await extract(mode);
      editTitle = pageDraft.source?.title || currentTab?.title || "";
      status = "Ready";
    } catch (e) {
      status = `Failed to extract ${mode}.`;
    } finally {
      busy = false;
    }
  }

  load().catch((error) => {
    status = error instanceof Error ? error.message : "Unable to load captures.";
  });
</script>

<main class="board-layout">
  <!-- STRIX CLIPPER HEADER -->
  <header class="header">
    <div class="header-tools">
      <button 
        class="tool-btn {captureMode === 'page' ? 'active' : ''}" 
        onclick={() => setCaptureMode('page')}
        title="Capture Page"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        Page
      </button>
      <button 
        class="tool-btn {captureMode === 'selection' ? 'active' : ''}" 
        onclick={() => setCaptureMode('selection')}
        title="Capture Selection"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
        Highlight
      </button>
      <button 
        class="tool-btn {captureMode === 'bookmark' ? 'active' : ''}" 
        onclick={() => setCaptureMode('bookmark')}
        title="Capture Bookmark"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
        Bookmark
      </button>
    </div>
    
    <div class="header-right">
      <div class="shortcut">⌘K</div>
      <button class="icon-btn" onclick={openOptions} title="Settings">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
  </header>

  <div class="sections">
    <!-- SOURCE -->
    <div class="board-section">
      <div class="section-label">SOURCE</div>
      <div class="section-content">
        <textarea bind:value={editTitle} rows="1" class="source-title-input" placeholder="Title..."></textarea>
        <div class="source-url">{hostname || 'No host'}</div>
      </div>
    </div>

    <!-- MEANING -->
    <div class="board-section">
      <div class="section-label">MEANING</div>
      <div class="section-content">
        <textarea bind:value={meaningText} rows="2" class="meaning-input" placeholder="Why is this worth saving?"></textarea>
      </div>
    </div>

    <!-- SAVE INTO -->
    <div class="board-section">
      <div class="section-label">SAVE INTO</div>
      <div class="section-content boxes">
        {#each boxes as box}
          <button 
            class="box-btn {selectedBox === box ? 'active' : ''}" 
            onclick={() => selectedBox = box}
          >
            <!-- visual color dot -->
            <span class="dot {box.toLowerCase()}"></span>
            <span class="bracket">[</span><span class="box-text">{box}</span><span class="bracket">]</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- EXTRACT -->
    <div class="board-section">
      <div class="section-label">EXTRACT</div>
      <div class="section-content extract-boxes">
        <button class="extract-btn"><span class="bracket">[</span>Summary<span class="bracket">]</span></button>
        <button class="extract-btn"><span class="bracket">[</span>Quote<span class="bracket">]</span></button>
        <button class="extract-btn"><span class="bracket">[</span>Tags<span class="bracket">]</span></button>
      </div>
    </div>
  </div>

  <footer class="footer">
    <div class="footer-spacer"></div>
    <button class="add-btn" disabled={busy} onclick={commitCapture}>
      {status === 'Ready' ? 'Add to Strix →' : status}
    </button>
  </footer>
</main>

<style>
  .board-layout {
    display: flex;
    flex-direction: column;
    padding: 16px 20px;
    background: var(--bg);
    min-height: 440px;
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
  
  .tool-btn:hover {
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
  
  .icon-btn:hover {
    color: var(--text-main);
    background: var(--bg-card);
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
  }

  .board-section {
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .board-section:last-child {
    border-bottom: none;
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

  /* Source */
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
  .source-title-input:focus { outline: none; }

  .source-url {
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  /* Meaning */
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
  .meaning-input:focus { outline: none; }

  /* Save Into */
  .boxes {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .box-btn {
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

  .bracket {
    color: var(--border-focus);
    font-family: var(--font-mono);
    transition: color 0.2s;
  }

  .box-btn:hover {
    color: var(--text-main);
  }
  
  .box-btn.active {
    color: var(--accent-cream);
  }
  
  .box-btn.active .bracket {
    color: var(--text-muted);
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

  /* Extract */
  .extract-boxes {
    display: flex;
    gap: 16px;
    flex-direction: row;
  }

  .extract-btn {
    background: transparent;
    border: none;
    padding: 4px 0;
    font-size: 13px;
    color: var(--text-muted);
    transition: color 0.2s;
  }

  .extract-btn:hover {
    color: var(--text-main);
  }
  
  .extract-btn:hover .bracket {
    color: var(--text-dim);
  }

  /* Footer */
  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  .footer-spacer {
    flex: 1;
  }

  .add-btn {
    background: transparent;
    border: none;
    color: var(--text-main);
    font-size: 13px;
    font-weight: 500;
    padding: 4px 0;
    transition: color 0.2s;
  }
  .add-btn:hover:not(:disabled) {
    color: var(--accent-cream);
  }
  .add-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
