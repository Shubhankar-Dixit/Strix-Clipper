<script lang="ts">
  import browser from "webextension-polyfill";
  import type {
    ListCapturesResponse,
    SettingsResponse,
    StatsResponse,
    SyncResponse
  } from "../lib/messages";
  import type {
    CaptureStats,
    StrixClipperSettings
  } from "../types/capture";

  let settings: StrixClipperSettings = {
    apiBaseUrl: "",
    apiToken: "",
    defaultDestination: "library"
  };
  let stats: CaptureStats = {
    total: 0,
    local: 0,
    pending: 0,
    synced: 0,
    error: 0
  };
  let status = "Ready";
  let busy = false;

  async function sendMessage<T>(message: unknown): Promise<T> {
    return (await browser.runtime.sendMessage(message)) as T;
  }

  async function load() {
    const [settingsResponse, statsResponse] = await Promise.all([
      sendMessage<SettingsResponse>({ type: "settings:get" }),
      sendMessage<StatsResponse>({ type: "captures:stats" })
    ]);
    settings = settingsResponse.settings;
    stats = statsResponse.stats;
  }

  async function save() {
    busy = true;
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

  async function exportJson() {
    busy = true;
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

  load().catch((error) => {
    status = error instanceof Error ? error.message : "Unable to load settings.";
  });
</script>

<main class="options">
  <header>
    <p class="eyebrow">SETTINGS</p>
    <h1>Strix Configuration</h1>
  </header>

  <section>
    <h2>Connection</h2>
    <div class="form">
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
    <div class="row">
      <button class="primary" type="button" disabled={busy} onclick={save}>Save Settings</button>
      <button class="secondary" type="button" disabled={busy} onclick={sync}>Retry Sync</button>
    </div>
  </section>

  <section>
    <h2>Local Data</h2>
    <div class="stats">
      <span>{stats.total}<br/><small>TOTAL</small></span>
      <span>{stats.local}<br/><small>LOCAL</small></span>
      <span>{stats.pending}<br/><small>PENDING</small></span>
      <span>{stats.synced}<br/><small>SYNCED</small></span>
      <span>{stats.error}<br/><small>ERROR</small></span>
    </div>
    <div class="row">
      <button class="secondary" type="button" disabled={busy} onclick={exportJson}>Export JSON</button>
      <button class="danger" type="button" disabled={busy} onclick={clearLocalData}>Clear Local</button>
    </div>
  </section>

  <p class="status" aria-live="polite">{status}</p>
</main>

<style>
  .options {
    display: flex;
    flex-direction: column;
    gap: 32px;
    margin: 0 auto;
    max-width: 600px;
    padding: 64px 24px;
    min-height: 100vh;
    background: var(--bg);
  }

  header {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 16px;
  }

  .eyebrow {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin: 0;
  }

  h1 {
    font-family: var(--font-serif);
    font-size: 36px;
    font-weight: 400;
    margin: 0;
    color: var(--text-main);
  }

  h2 {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin: 0 0 8px 0;
  }

  section {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 32px;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .row {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }

  .stats {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }

  .stats span {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-main);
    font-family: var(--font-mono);
    font-size: 18px;
    padding: 16px 8px;
    text-align: center;
  }

  .stats small {
    display: block;
    font-size: 9px;
    color: var(--text-muted);
    margin-top: 4px;
    letter-spacing: 0.05em;
  }

  .status {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    text-align: center;
    margin-top: 16px;
  }
</style>
