import type {
  CaptureDestinationTarget,
  CaptureDraft,
  CaptureRecord,
  CaptureStats,
  StrixClipperSettings
} from "../types/capture";

export type ContentExtractKind =
  | "smart"
  | "page"
  | "selection"
  | "bookmark"
  | "highlight"
  | "video-moment"
  | "thread";

export type ContentMessage =
  | {
      type: "strix:extract";
      kind: ContentExtractKind;
      defaultDestination?: CaptureDestinationTarget;
    }
  | {
      type: "strix:activate-highlight-mode";
    }
  | {
      type: "strix:refresh-highlights";
    }
  | {
      type: "strix:restore-context";
      scrollY?: number;
      textQuote?: string;
    };

export type BackgroundMessage =
  | { type: "captures:create"; draft: CaptureDraft }
  | { type: "captures:delete"; captureId: string }
  | { type: "captures:list"; limit?: number }
  | { type: "captures:for-url"; url: string; canonicalUrl?: string }
  | { type: "captures:stats" }
  | { type: "captures:sync" }
  | { type: "captures:open"; captureId: string }
  | { type: "captures:clear" }
  | { type: "settings:get" }
  | { type: "settings:set"; settings: StrixClipperSettings };

export type CreateCaptureResponse = {
  capture: CaptureRecord;
};

export type ListCapturesResponse = {
  captures: CaptureRecord[];
};

export type StatsResponse = {
  stats: CaptureStats;
};

export type SyncResponse = {
  skipped: boolean;
  attempted: number;
  synced: number;
  failed: number;
  message: string;
};

export type SettingsResponse = {
  settings: StrixClipperSettings;
};
