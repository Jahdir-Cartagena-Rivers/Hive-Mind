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

2026-10-28 validation: focused9 tests pass. Full regression152 Node tests
and67 core tests passed before the additional passing version-parity check.
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

Publication scan passed150 tracked files and51 commits before the account-connect
plan was added. Final scan/source push/release and downloadable verification are
next; do not call this released yet.

Cloud-only OAuth onboarding and first-time Google OAuth/key provisioning remain
separate deployment work. Existing per-host Drive sync is reused; exporting a
plugin does not configure or certify it. No user data was used as test input.
User clarification 2026-10-28: the intended experience is connect Google account,
like a Drive plugin. Users must not need their own domain or hosting account.
They are open to a Google project if needed. Use product-managed execution for
cloud-only hosts; Drive remains canonical storage. Do not turn deployment details
into user prerequisites. No local public listener is introduced. See
ACCOUNT-CONNECT-PLAN.md for the follow-up implementation contract.
