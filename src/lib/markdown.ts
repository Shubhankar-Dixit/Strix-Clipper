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
