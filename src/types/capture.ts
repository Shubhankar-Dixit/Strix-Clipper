export type CaptureKind =
  | "page"
  | "selection"
  | "bookmark"
  | "image"
  | "highlight"
  | "video-moment"
  | "thread";

export type CaptureDestinationTarget =
  | "strix-captures"
  | "note"
  | "memory"
  | "canvas";

export type SyncStatus = "local" | "pending" | "synced" | "error";

export type CaptureSource = {
  url: string;
  canonicalUrl?: string;
  title?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  capturedAt: string;
  faviconUrl?: string;
};

export type CaptureContent = {
  text?: string;
  markdown?: string;
  html?: string;
  selectionText?: string;
  excerpt?: string;
  imageUrls?: string[];
};

export type CaptureContext = {
  scrollY?: number;
  textQuote?: string;
  textFragment?: string;
  pageKey?: string;
  viewport?: {
    width: number;
    height: number;
  };
  imageUrl?: string;
  threadUrl?: string;
  video?: {
    provider: "youtube" | "x" | "vimeo" | "generic";
    videoId?: string;
    timestampSeconds: number;
    durationSeconds?: number;
    transcriptText?: string;
  };
};

export type CaptureDestination = {
  target: CaptureDestinationTarget;
  noteId?: string;
  folderId?: string;
  tags?: string[];
};

export type CaptureSync = {
  status: SyncStatus;
  remoteId?: string;
  lastError?: string;
};

export type CaptureDraft = {
  kind: CaptureKind;
  source: CaptureSource;
  content: CaptureContent;
  context: CaptureContext;
  destination?: Partial<CaptureDestination>;
};

export type CaptureRecord = CaptureDraft & {
  id: string;
  createdAt: string;
  destination: CaptureDestination;
  sync: CaptureSync;
};

export type CaptureStats = Record<SyncStatus | "total", number>;

export type StrixClipperSettings = {
  apiBaseUrl: string;
  apiToken: string;
  defaultDestination: CaptureDestinationTarget;
};
