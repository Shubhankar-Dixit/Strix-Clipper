# Strix Clipper

Strix Clipper is a local-first browser extension for saving pages, selections,
bookmarks, and images into a local capture queue for Strix.

Phase 1 targets Chrome Manifest V3. Captures are stored in IndexedDB first, so
the extension remains useful without a network connection or Strix API endpoint.
When a Strix API base URL and token are configured, the extension can retry sync
to `POST /api/clipper/captures`.

## Development

Install dependencies:

```sh
npm install
```

Run checks:

```sh
npm run typecheck
npm run build
```

Load the extension:

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Select Load unpacked.
5. Choose the generated `dist/` folder.

## Phase 1 Features

- Save current page as a Markdown-backed capture.
- Save selected text.
- Save bookmark metadata, including scroll position when available.
- Save images from the right-click context menu.
- Store all captures locally in IndexedDB.
- Show recent captures and sync counts in the popup.
- Configure Strix API URL/token in the options page.
- Export local captures as JSON.
- Retry sync without deleting failed local captures.

## Deferred

Templates, OAuth, and richer server-side routing are planned after the base
local clipper is working.
