# Hive Mind 0.6.1

Fix general-memory writes from J1 Code being rejected when project is null.
General memories now accept an omitted or null project. Invalid project scopes,
malformed fields and read-only writes continue to reject. Existing records,
Drive configuration, connector credentials and profile locations are unchanged.

Validation includes recall after restart, neighboring project saves, malformed
inputs and read-only rejection. This release excludes the unfinished knowledge
rework.
