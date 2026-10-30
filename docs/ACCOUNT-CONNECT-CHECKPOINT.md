# Account-connect implementation checkpoint — 2026-10-29

User explicitly requests implementing and running the cloud Google-account
connection for easier plugin access. This continues ACCOUNT-CONNECT-PLAN.md;
native-only packaging is not the complete requested outcome. Preserve existing
brain, keys, Composio account and sync. No new production dependency is added.

Branch feat/account-connect-20261029; baseline75eb3b0. Isolated worktree with a
dependency junction to the earlier isolated plugin worktree. Do not package from
the junction; the prior checkpoint records its transitive-dependency build issue.

Implemented src/account-link.mjs uses documented Composio v3.1 sessions and v3
connected-account/proxy APIs. It pins the server-owned user and selected Drive
account, narrows sessions to Drive, reuses an explicit active account rather than
reauthorizing it, and returns only required link/session fields. Completion
requires a stored, unexpired, user/account-bound attempt and verifies provider
ownership/status instead of trusting callback query parameters. This module is
not yet wired to a public server, authenticated user session or durable attempt
store; its callback caller must supply those. No public readiness claim.

Live read-only verification through the actual existing Windows DPAPI-protected
credential succeeded: exact configured account ACTIVE, user/account binding
matches, Drive-only session created, existing account reused without a link, and
Drive v3 about GET returned a valid native user permission identity. No credential
or Google identity was printed. Proxy response returned no log_id, so complete
Composio log-trace qualification remains pending. The reproducible safe probe is
scripts/check-account-link.mjs. It creates a session but does not mutate Drive,
host settings or account authorization. Run it only when a live check is needed.

Validation:14 focused tests pass (5 account-link and9 neighboring plugin tests).
Publication scan155 tracked files and53reachable local commits passes.
Includes wrong user/account,
expired callback, revoked/disabled connection, wrong toolkit, malicious redirect,
provider rejection and no-secret-error output. Existing plugin/service unchanged.

Google Cloud console is signed in. The currently selected existing project
explicitly has no billing account linked, and Billing management showed no usable
account. The user was asynchronously asked to add/select a billing account;
never request payment details in chat. Cloud Run needs a billing-linked project
even when within free usage quotas. No billing activation, payment action or
billable compute deployment has occurred. A dedicated Hive Mind project was
created through the signed-in Google console, and its own dashboard title and
project information were independently read back. Resource identifier is kept in
the private session ledger; no project-specific secrets are committed here.
Two native preview_click calls had no observed form transition; DOM inspection
confirmed the form remained valid and enabled. A DOM button click then submitted
successfully. No duplicate creation or project cleanup was attempted.

Clarification2026-10-29: the user's comparison was Gyromi. Current MediaApp code
performs Google OAuth and direct Drive sync on the device; that path has no
Cloud Run dependency. Billing is required for the proposed Cloud Run deployment,
not Google sign-in, Drive sync or plugins generally. Do not treat adding billing
as an unconditional user prerequisite. Evaluate the existing remote-host or
managed-runtime route before choosing additional infrastructure. The user has
not categorically rejected paid hosting; do not infer that constraint.

Next: compare available execution hosts, then implement the
public authenticated gateway if needed, protected key provisioning and durable attempt/user
bindings. Prove cross-user rejection and actual cloud-only host roundtrip before
calling this up and running. Existing personal account need not reconnect.

Sources consulted: https://docs.composio.dev/docs/configuring-sessions and
https://docs.composio.dev/docs/authentication/manually-authenticating.
