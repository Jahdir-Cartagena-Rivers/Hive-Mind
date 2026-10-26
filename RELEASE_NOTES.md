# Hive Mind 0.4.1

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
