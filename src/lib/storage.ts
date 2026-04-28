import type {
  CaptureDraft,
  CaptureRecord,
  CaptureStats,
  SyncStatus
} from "../types/capture";
import { createId } from "./id";
import { getSettings } from "./settings";

const DB_NAME = "strix-clipper";
const DB_VERSION = 1;
const CAPTURE_STORE = "captures";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CAPTURE_STORE)) {
        const store = db.createObjectStore(CAPTURE_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("syncStatus", "sync.status");
      }
    };

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(CAPTURE_STORE, mode);
        const store = tx.objectStore(CAPTURE_STORE);
        let request: IDBRequest<T> | void;

        tx.oncomplete = () => {
          db.close();
          resolve(request ? request.result : undefined);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };

        request = work(store);
      })
  );
}

export async function createCapture(draft: CaptureDraft): Promise<CaptureRecord> {
  if (draft.kind === "highlight") {
    const existing = await findDuplicateHighlight(draft);
    if (existing) {
      return existing;
    }
  }

  const settings = await getSettings();
  const now = new Date().toISOString();
  const capture: CaptureRecord = {
    ...draft,
    id: createId(),
    createdAt: now,
    destination: {
      target: draft.destination?.target ?? settings.defaultDestination,
      noteId: draft.destination?.noteId,
      folderId: draft.destination?.folderId,
      tags: draft.destination?.tags
    },
    sync: {
      status: "local"
    }
  };

  await putCapture(capture);
  return capture;
}

export async function putCapture(capture: CaptureRecord): Promise<void> {
  await transaction("readwrite", (store) => store.put(capture));
}

export async function deleteCapture(id: string): Promise<void> {
  await transaction("readwrite", (store) => store.delete(id));
}

export async function listCaptures(limit?: number): Promise<CaptureRecord[]> {
  const captures =
    (await transaction<CaptureRecord[]>("readonly", (store) => store.getAll())) ?? [];

  return captures
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit ?? captures.length);
}

export async function getCapture(id: string): Promise<CaptureRecord | undefined> {
  return transaction<CaptureRecord>("readonly", (store) => store.get(id));
}

export async function listCapturesForPage(
  url: string,
  canonicalUrl?: string
): Promise<CaptureRecord[]> {
  const pageKeys = new Set([normalizePageKey(url), normalizePageKey(canonicalUrl)]);
  const captures = await listCaptures();

  return captures.filter((capture) => {
    const captureKeys = new Set([
      normalizePageKey(capture.context.pageKey),
      normalizePageKey(capture.source.canonicalUrl),
      normalizePageKey(capture.source.url)
    ]);

    for (const key of pageKeys) {
      if (key && captureKeys.has(key)) {
        return true;
      }
    }

    return false;
  });
}

export async function clearCaptures(): Promise<void> {
  await transaction("readwrite", (store) => store.clear());
}

export async function getCaptureStats(): Promise<CaptureStats> {
  const captures = await listCaptures();
  const stats: CaptureStats = {
    total: captures.length,
    local: 0,
    pending: 0,
    synced: 0,
    error: 0
  };

  captures.forEach((capture) => {
    stats[capture.sync.status] += 1;
  });

  return stats;
}

export async function listSyncableCaptures(): Promise<CaptureRecord[]> {
  const captures = await listCaptures();
  return captures.filter((capture) =>
    ["local", "error"].includes(capture.sync.status)
  );
}

export async function updateSyncStatus(
  capture: CaptureRecord,
  status: SyncStatus,
  remoteId?: string,
  lastError?: string
): Promise<CaptureRecord> {
  const updated: CaptureRecord = {
    ...capture,
    sync: {
      status,
      remoteId,
      lastError
    }
  };
  await putCapture(updated);
  return updated;
}

function findDuplicateHighlight(draft: CaptureDraft): Promise<CaptureRecord | undefined> {
  const quote = draft.context.textQuote?.trim();
  if (!quote) {
    return Promise.resolve(undefined);
  }

  const draftKey = normalizePageKey(
    draft.context.pageKey ?? draft.source.canonicalUrl ?? draft.source.url
  );

  return listCaptures().then((captures) =>
    captures.find(
      (capture) =>
        capture.kind === "highlight" &&
        capture.context.textQuote?.trim() === quote &&
        normalizePageKey(
          capture.context.pageKey ?? capture.source.canonicalUrl ?? capture.source.url
        ) === draftKey
    )
  );
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
