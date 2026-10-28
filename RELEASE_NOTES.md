# Hive Mind 0.6.0

- Connect AI clients through a dependency-free MCP plugin using the existing private host connection.
- Export a token-free Codex/Claude plugin from Settings, with read-only/read-write access and optional exact project fact filtering.
- Install through the repository's Codex or Claude marketplace, or configure another stdio MCP host.
- Include shared-memory guidance for recall, corrections, tasks and forgetting.

Project restrictions apply at this connector; the underlying service credential
is unchanged. Selected-project connections expose facts only. Full-store
connections retain task and reference tools. No storage migration occurs.
Public cloud OAuth hosting and first-time Drive account/key provisioning are
separate setup work. Plugin installation does not guarantee automatic agent use.

## Previous release: 0.5.2

- Keep status available after the retained change-event window advances.
- Start fresh event subscriptions at the current head while still rejecting expired replay cursors.

## Previous release: 0.5.1

- Keep each host's consumption cursor and active client context local during sync.
- Add account-bound sealed credential attachments for private application consumers.
- Add a headless service with the same protected background sync worker.

Credential attachments require explicit host-owned account, asset and application
bindings. Passwords remain outside searchable memory and are decrypted only in a
private application pipe. Installation does not provision credentials or configure
a remote supervisor automatically.

## Previous release: 0.5.0

- Add opt-in encrypted Drive synchronization through an explicitly selected Composio account.
- Merge independent edits and report conflicting corrections without silently overwriting them.
- Propagate Forget and remove tracked older Drive backups that may contain forgotten content.
- Protect cloud keys on Windows with DPAPI and on remote hosts with their existing protected credential environment.
- Sync in the desktop background and show connection, conflict and deletion-cleanup status.

Drive sync requires private host configuration and protected-key provisioning.
Upgrading does not move an existing store or connect an account automatically.
Offline clients apply deletions when they reconnect; provider internal backups
and independently retained copies are outside the sync service's deletion scope.

## Previous release: 0.4.1

- See connected chats' current activity in the desktop app and relevant working context.
- Flag chats working on the same task and remove stale activity automatically.
- Share short status categories without storing commands, file paths, or tool output.
- Keep the existing background updater and memory store intact.

Live activity requires a reporting client, including J1 Code configured to use
standalone Hive Mind as its brain. Heartbeats are temporary and do not change
durable memory history.

## Previous release: 0.4.0

- Check for and download updates automatically in the background.
- Choose **Restart to update** from the tray menu to install a verified update and restart Hive Mind, including its bundled service.
- Preserve memory revisions and avoid redundant synchronization when a saved fact has not changed.
- Include smaller relevant notes when a larger note cannot fit the remaining context budget.

Earlier versions need one bootstrap update to acquire the built-in updater. The update script downloads and verifies the installer automatically; no manual installer download is needed.
