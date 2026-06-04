# Vendored Codex browser-use artifacts

This directory contains local reference snapshots for learning and experiments.
They are intentionally not wired into `pi-codex-computer-use` runtime behavior.

## `codex-chrome-extension/`

Unpacked build of the public Codex Chrome Web Store extension.

- Extension ID fetched: `hehggadaopoacecdllhhajmbjkdcmajg`
- Web Store version at fetch time: `1.1.5`
- Provenance: downloaded from Google's CRX update endpoint, stripped of the CRX
  header, and unzipped.
- Contents are generated/minified extension assets, not original TypeScript
  source.
- The Chrome Web Store `_metadata/` directory is intentionally omitted so this
  directory can be loaded as an unpacked developer extension.

You can load this directory as an unpacked extension in a Chromium-family
browser for local testing:

1. Open `brave://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select `extensions/pi-codex-computer-use/vendor/codex-chrome-extension`.

Native messaging will not connect until the browser's native host manifest
allows the new unpacked extension ID.

## `codex-chrome-plugin/`

Snapshot of Codex.app's bundled Chrome plugin from the local Codex plugin cache.
It includes the plugin metadata, diagnostics scripts, `browser-client.mjs`,
skills/docs, and the platform native host binary available on this machine.

Treat this snapshot as reference material. Modifying the vendored
`scripts/browser-client.mjs` is safe for study, but using a modified copy at
runtime may fail because Codex.app/native host versions are tightly coupled and
the native host appears to verify trusted browser-client state.
