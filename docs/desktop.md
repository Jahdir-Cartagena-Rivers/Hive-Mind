# Hive Mind desktop app

Hive Mind is its own application: a memory store, a built-in semantic index, a
Markdown vault, a skills catalog, and a graph you explore in the app. It does not
require J1 Code, Obsidian, or Hindsight.

## Run it

```powershell
npm ci
npm run app          # development
npm run dist         # Windows installer in dist/
```

The app starts the service on `127.0.0.1:8788` (set `HIVE_MIND_PORT` to change it)
and keeps running in the tray when you close the window, so other applications can
keep using it. Data lives in the app's user-data folder
(`%APPDATA%\Hive Mind\data`); set `HIVE_MIND_STATE_DIR` to use another absolute
directory. Quit from the tray menu.

## What you can do

- **Graph.** Every memory is a node, each project is a hub, and amber edges join
  memories that are close in meaning. Click a hub to filter to its project; click a
  memory to read, edit, or forget it and to jump to its neighbors.
- **Search.** Keyword and meaning-based ranking over all memories.
- **Settings.** Choose a vault folder (notes are plain Markdown, so any editor can
  open them), add skills folders, toggle automatic sync and start-with-Windows, and
  import original documents from a Hindsight bank (read-only).

## Semantic index

Each memory is embedded locally with `bge-small-en-v1.5` (about 3 ms per memory, CPU
only, no language-model calls). The model files, about 35 MB, download once into
the data folder. Set `HIVE_MIND_SEMANTIC=off` to skip the model; search is then
keyword-only and the graph shows project hubs without meaning links.

## Connecting other applications

On startup the app writes `~/.hive-mind/connection.json` with the service origin,
MCP address, and a bearer token (the file is readable only by your account).
Applications that find this file can use:

- **MCP** at `http://127.0.0.1:8788/mcp` with `Authorization: Bearer <token>`. Tools:
  `hive_mind_recall`, `hive_mind_remember`, `hive_mind_forget`, `hive_mind_status`,
  `hive_mind_sync`.
- **HTTP** operations listed in [service.md](service.md), plus `POST /v1/graph`,
  `POST /v1/memory`, and `POST /v1/context` (prompt-ready background notes).

Settings has a "Copy token" button that clears the clipboard after 30 seconds.
Provide the token to clients through their credential storage, never a URL.

## Migrating from J1 Code's built-in Hive Mind

The service refuses installed `.j1`/`.t3` profiles by design. To move existing
memories, copy `hive-mind.json` (and, if present, `hive-mind.vectors.json`) from
the J1 user-data folder into this app's data folder while neither application is
running. Copy rather than link, and keep the original until you have checked the
result. The first sync builds any missing vectors.
