# Strix Clipper

Strix Clipper is a local-first browser extension for saving pages, selections,
bookmarks, and images into a local capture queue.

The goal is to be able to make an extension that can let AI agents browse the web and capture parts of it and save it in the state that it's left in without losing any context. Bookmarks get cluttered and don't save content and the state of webpages properly which is what this is meant to solve.

AI was used in bug fixes mainly and writing some boring rust code but majority of it was written by HI (Human intelligence).

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
5. Choose the `dist/` folder. (This should be generated after you do the previous steps)

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

## Planned Features

- Fast and lightweight code for browser context
- Editing dynamically the content of a webpage
- Better capturing on specific sites
- A new framework for content extraction from websites
- Improve UI

## Deferred

Templates, OAuth, and richer server-side routing are planned after the base
local clipper is working.

---

This is how it looks:

<img width="470" height="877" alt="image" src="https://github.com/user-attachments/assets/359f9b87-59f4-4edb-b037-6379110c697a" />

