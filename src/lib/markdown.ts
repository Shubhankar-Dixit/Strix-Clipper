import type { CaptureRecord } from "../types/capture";

export function captureToMarkdown(capture: CaptureRecord): string {
  const title = capture.source.title || capture.source.url;
  const lines = [`# ${title}`, ""];

  lines.push(`Source: ${capture.source.url}`);
  lines.push(`Captured: ${capture.source.capturedAt}`);

  if (capture.source.author) {
    lines.push(`Author: ${capture.source.author}`);
  }

  if (capture.source.publishedAt) {
    lines.push(`Published: ${capture.source.publishedAt}`);
  }

  if (capture.context.scrollY !== undefined) {
    lines.push(`Scroll: ${Math.round(capture.context.scrollY)}px`);
  }

  if (capture.context.video) {
    const seconds = Math.max(0, Math.floor(capture.context.video.timestampSeconds));
    lines.push(`Video: ${capture.context.video.provider}`);
    lines.push(`Timestamp: ${seconds}s`);

    if (capture.context.video.videoId) {
      lines.push(`Video ID: ${capture.context.video.videoId}`);
    }
  }

  if (capture.context.threadUrl) {
    lines.push(`Thread: ${capture.context.threadUrl}`);
  }

  if (capture.context.imageUrl) {
    lines.push("");
    lines.push(`![Captured image](${capture.context.imageUrl})`);
  }

  const body =
    capture.content.selectionText ??
    capture.content.markdown ??
    capture.content.text ??
    capture.content.excerpt;

  if (body) {
    lines.push("");
    lines.push(body.trim());
  }

  return `${lines.join("\n")}\n`;
}
