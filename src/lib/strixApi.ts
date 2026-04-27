import type { CaptureRecord, StrixClipperSettings } from "../types/capture";
import { isSyncConfigured } from "./settings";
import {
  listSyncableCaptures,
  updateSyncStatus
} from "./storage";
import type { SyncResponse } from "./messages";

type SyncSuccessPayload = {
  id?: string;
  remoteId?: string;
};

export async function postCaptureToStrix(
  capture: CaptureRecord,
  settings: StrixClipperSettings
): Promise<SyncSuccessPayload> {
  const response = await fetch(`${settings.apiBaseUrl}/api/clipper/captures`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(capture)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Sync failed with HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return {};
  }

  return (await response.json()) as SyncSuccessPayload;
}

export async function syncCaptures(
  settings: StrixClipperSettings
): Promise<SyncResponse> {
  if (!isSyncConfigured(settings)) {
    return {
      skipped: true,
      attempted: 0,
      synced: 0,
      failed: 0,
      message: "Add a Strix API URL and token in options to enable sync."
    };
  }

  const captures = await listSyncableCaptures();
  let synced = 0;
  let failed = 0;

  for (const capture of captures) {
    const pending = await updateSyncStatus(capture, "pending");
    try {
      const result = await postCaptureToStrix(pending, settings);
      await updateSyncStatus(
        pending,
        "synced",
        result.remoteId ?? result.id ?? pending.sync.remoteId
      );
      synced += 1;
    } catch (error) {
      await updateSyncStatus(
        pending,
        "error",
        pending.sync.remoteId,
        error instanceof Error ? error.message : "Unknown sync error"
      );
      failed += 1;
    }
  }

  return {
    skipped: false,
    attempted: captures.length,
    synced,
    failed,
    message: `Synced ${synced} of ${captures.length} capture${captures.length === 1 ? "" : "s"}.`
  };
}
