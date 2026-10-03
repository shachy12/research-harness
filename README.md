# Harness

## Install

Requires Node 24 or newer.

```bash
npx research-harness
```

This starts Harness at http://127.0.0.1:47831 and opens it in your browser. Update with `npx research-harness@latest`.

To open it in its own desktop window instead of a browser tab:

```bash
npx research-harness --app
```

The first time, this downloads Electron (about 100 MB) into the data folder; later runs start at once. Closing the window stops Harness.

Options: `--app`, `--no-open` (don't open the browser), `--port <n>`.

Your data is stored in `%APPDATA%\research-harness` on Windows, `~/Library/Application Support/research-harness` on macOS and `~/.local/share/research-harness` on Linux. Set `HARNESS_DATA_DIR` to use another folder.

## Publish

From the repository root:

1. Bump `version` in `apps/cli/package.json` (a published version can't be overwritten).
2. Publish (npm asks for your 2FA code; the web UI and the bundle are built automatically):

   ```bash
   cd apps/cli
   npm publish --access public
   ```
