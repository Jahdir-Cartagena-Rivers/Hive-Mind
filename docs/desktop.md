# Hive Mind desktop app

## Updates on Windows

The installed Windows app checks for releases in the background and downloads
verified updates. Choose **Restart to update** from the tray menu when an update
is ready. Hive Mind drains its bundled service before installation, then restarts
with the new application and service together. Your memory, vault and credentials
stay in the existing profile.

Versions released before 0.4.0 need one bootstrap update. Run this in PowerShell;
it downloads and verifies the installer automatically:

```powershell
irm https://raw.githubusercontent.com/Jahdir-Cartagena-Rivers/Hive-Mind/main/scripts/update-hive-mind.ps1 | iex
```

The bootstrap asks you to quit the old app from its tray first. Future updates use
the built-in tray action. Source checkouts are updated with Git instead.

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

- **Memory space.** Explore glowing memory orbs on project islands. Drag to orbit,
  Shift-drag to pan, or scroll to zoom. Click an orb for a preview, then open the
  actual memory or retained reference. Arrow keys rotate, +/− zoom, and Home resets.
  Colors describe projects, memory kinds, or your boards; they do not infer emotions.
- **Organizer.** Browse searchable cards with image thumbnails. Create visual
  boards, move a card with its board selector or drag it onto a board, and pin
  favorites. Boards, colors and pins are saved on this device for this store.
  They do not change memory content, project scope, preferences, or AI recall.
  Removing a board leaves its memories intact. These local layouts are separate
  from canonical memory backups and are reset when restoring a different store.
- **Connections.** Every memory is a node, each project is a hub, and amber edges join
  memories that are close in meaning. Click a hub to filter to its project; click a
  memory to read, edit, or forget it and to jump to its neighbors.
- **Search.** Keyword and meaning-based ranking over all memories.
- **Settings.** Choose a vault folder (notes are plain Markdown, so any editor can
  open them), add skills folders, toggle automatic sync and start-with-Windows, and
  import original documents from a Hindsight bank (read-only).

The 3D view draws on demand and sleeps between interactions. It shows up to 800
orbs at a time; use the filters or Organizer to find the rest. Cards load in pages
of 60. Image previews are resized and decoded one at a time; very large images
remain available through their original reference without automatic thumbnail
decoding. The Organizer provides a keyboard-accessible alternative to the canvas.

## Tasks, preferences and visual references

Use **Tasks and references** to keep objectives, decisions, failed attempts, open
questions and next actions outside an individual chat. Tasks can be claimed and
released so concurrent chats can see who is working on them. Preferences include
their context and exceptions; user-entered preferences remain distinct from agent
notes. Collections group images with notes and optional normalized regions.

Retain images or model/document/source files under **Images and files**, then
link them to collections, preferences, tasks or artifact versions. Retained bytes
survive removal of the original file. **Save a copy** retrieves the original;
**Back up** includes retained bytes and metadata. Restore requires an empty
environment and preserves existing nonempty environments by rejecting the import.
Images are limited to 10 MiB, other files to 25 MiB, and backups to 64 MiB.

**Find similar images** compares coarse appearance descriptors for images imported
through the desktop; other clients can supply compatible descriptors. This is
layout/tone matching, not a general visual understanding model. Text/meaning
search and actual image retrieval complement it. An upload or similar-looking
image does not establish that you like it; record your preference explicitly.

Artifact history separates the latest version from a preferred earlier version.
The graph links these records to their references and related task. Search covers
both ordinary memories and continuity records. Changes and completed index passes
refresh the interface through notifications; periodic reconciliation remains as
recovery.

## Semantic index

Each memory is embedded locally with `bge-small-en-v1.5` (about 3 ms per memory, CPU
only, no language-model calls). The model files, about 35 MB, download once into
the data folder. Set `HIVE_MIND_SEMANTIC=off` to skip the model; search is then
keyword-only and the graph shows project hubs without meaning links.

## Connecting other applications

For Codex, Claude Code and other local MCP apps, use **Settings → Connect an AI**.
Check the connection, choose access and projects, then export a plugin folder.
Its start-here guide includes installation commands; credentials stay in the
private host connection file. See the [AI plugin guide](plugins.md) for remote
hosts, scope boundaries and setup from the repository.

On startup the app writes `~/.hive-mind/connection.json` with the service origin,
MCP address, and a bearer token (the file is readable only by your account).
Applications that find this file can use:

- **MCP** at `http://127.0.0.1:8788/mcp` with `Authorization: Bearer <token>`. Tools:
  `hive_mind_recall`, `hive_mind_remember`, `hive_mind_forget`, `hive_mind_status`,
  `hive_mind_sync`, `hive_mind_record`, `hive_mind_working_context`,
  `hive_mind_presence`, `hive_mind_image` and `hive_mind_file`. Image reads return actual MCP image
  content; file reads return an embedded resource with retained bytes.
- **HTTP** operations listed in [service.md](service.md), plus `POST /v1/graph`,
  `POST /v1/memory`, and `POST /v1/context` (prompt-ready background notes).

Settings has a "Copy token" button that clears the clipboard after 30 seconds.
Provide the token to clients through their credential storage, never a URL.

J1 uses its built-in store by default. To use this service as its primary brain,
select **Standalone Hive Mind** in J1's **Settings → Hive Mind** and save setup.
The connection file belongs to the J1 server host, including when you use J1 from
a phone or remote browser. Switching modes does not copy or merge stores; J1
preserves the built-in store and connection settings for switching back. External
outages are reported without silently writing into built-in memory.

## Migrating from J1 Code's built-in Hive Mind

The service refuses installed `.j1`/`.t3` profiles by design. To move existing
memories, copy `hive-mind.json` (and, if present, `hive-mind.vectors.json`) from
the J1 user-data folder into this app's data folder while neither application is
running. Copy rather than link, and keep the original until you have checked the
result. The first sync builds any missing vectors.
