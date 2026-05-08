import type {
  CaptureDestinationTarget,
  CaptureExtractionSettings,
  CaptureDraft,
  CaptureRecord,
  CaptureStats,
  StrixClipperSettings
} from "../types/capture";

export type ContentExtractKind =
  | "smart"
  | "page"
  | "page-state"
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
      extractionSettings?: Partial<CaptureExtractionSettings>;
    }
  | {
      type: "strix:activate-highlight-mode";
    }
  | {
      type: "strix:refresh-highlights";
    }
  | {
      type: "strix:add-selection-highlight";
    }
  | {
      type: "strix:clip-page-highlights";
    }
  | {
      type: "strix:deactivate-highlight-mode";
    }
  | {
      type: "strix:play-clip-feedback";
      kind?: CaptureDraft["kind"];
    }
  | {
      type: "strix:restore-context";
      scrollX?: number;
      scrollY?: number;
      textQuote?: string;
      formState?: CaptureRecord["context"]["formState"];
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
