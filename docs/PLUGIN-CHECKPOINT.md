# Hive Mind plugin milestone — 2026-10-28

Objective: turn the existing standalone Hive Mind core into an installable,
token-free AI connector with guided setup and two-client continuity qualification.
User approved implementation in the Auto Apply conversation on 2026-10-28.
Preserve live stores, keys and current sync; no canonical migration is needed.

Branch: feat/ai-plugin-20261028, baseline b1e689f. Clean inherited checkout;
implementation uses a separate worktree. Initial dependency junction was moved
into ignored dist/shared-node-modules-link after electron-builder omitted its
transitive ONNX packages. A separate npm ci now supplies the worktree dependencies;
the original source checkout and its dependency directory are preserved.

Implementation: dependency-free stdio bridge discovers the existing private
connection file, with explicit read-only/read-write access and optional exact
project fact filtering. Full-store connections retain existing continuity tools.
Scoped connections expose facts only, so linked files, tasks and ambient context
cannot leak across scopes. Restrictions apply to this connector; the service
credential itself is not a scoped credential. The AI host runs local code with
its own filesystem permissions. No new production dependency or public listener.

Packaging: Codex/Claude manifests and shared-memory skill, portable CLI export,
desktop guided export and generic stdio configuration. Source package defaults
to read-only. Installed host settings are not silently edited.

2026-10-28 final validation: focused9 tests pass. Release-source CI passed
153 Node tests and67 core tests, including the added version-parity check.
Actual Codex native plugin install/discovery/tool write and second-client readback
passed in temporary profiles, along with Claude native plugin loading/health.
No model turn or production account/store was used. Native evidence:
`%TEMP%/hive-native-plugin-gloaTR/report.json` (final runtime).
Actual Electron renderer/IPC check, empty-project rejection and configured export
passed beside task/image/visual/presence smoke. Screenshot visually reviewed:
`%TEMP%/hive-continuity-ui-nLdITv/desktop-plugin.png`.
Final self-contained packaged app smoke passed at
`%TEMP%/hive-continuity-ui-hmJmq2/result.txt`. All five runtime dependencies
resolve and load from inside the packaged app, including ONNX's transitive common
package. No new production dependency was added.
The first neighboring task test expected a wrapper the service does not return;
correcting the fixture to the existing contract made it pass. No service repair.

## Published native plugin

Main implementation and immutable tag v0.6.0:
`e9c738eed6452c9b986af446ff0527906e53adc1`.
Source CI40741066249 and40741189646 passed. Windows release CI40741189567
passed and published [Hive Mind0.6.0](https://github.com/Jahdir-Cartagena-Rivers/Hive-Mind/releases/tag/v0.6.0).
Final publication scan151files passed; CI scanned31reachable commits and3128
historical entries, while the earlier local scan included additional local refs.

Downloaded plugin ZIP and Windows installer match their published SHA256/size
manifests. Plugin manifest binds the exact implementation commit. Actual plugin
runtime, both native host manifests, MCP configs and skill match tagged source;
the ZIP includes dot-directories, license and START_HERE.txt and defaults to read.

Plugin:8717bytes, SHA256
`7169e099803979f6f52765902c270a1c767339bea0f117256ecbf14c60a7abd6`.
Installer:192074101bytes, SHA256
`3e0eb5e9fc874d75ee84c845a72c545f1641c7988f2a2dd4b8eff3c51694048f`.

The downloaded NSIS payload was extracted without installing over the live app.
Its actual packaged executable passed desktop/IPC/export plus neighboring
task/image/presence/visual smoke at `%TEMP%/hive-continuity-ui-rAM5Xg/result.txt`.
The first extraction attempt used the legacy7zip16 vendor binary, which cannot
decode ARM64 compression; builder's cached7zip24.09 extracted all2622files
successfully. This was a test-tool limitation, not an installer defect.

Installed production app, profile, sync and AI host configuration were not changed
or restarted. Native host installation tests used temporary profiles only.
The local/native-host plugin milestone is delivered. Hosted account linking is
not delivered by this release. Next action: implement and qualify
ACCOUNT-CONNECT-PLAN.md, preserving current personal Drive/Composio bindings.

Cloud-only OAuth onboarding and first-time Google OAuth/key provisioning remain
separate deployment work. Existing per-host Drive sync is reused; exporting a
plugin does not configure or certify it. No user data was used as test input.
User clarification 2026-10-28: the intended experience is connect Google account,
like a Drive plugin. Users must not need their own domain or hosting account.
They are open to a Google project if needed. Use product-managed execution for
cloud-only hosts; Drive remains canonical storage. Do not turn deployment details
into user prerequisites. No local public listener is introduced. See
ACCOUNT-CONNECT-PLAN.md for the follow-up implementation contract.
