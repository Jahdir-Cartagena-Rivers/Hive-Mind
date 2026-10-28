# Account-connect onboarding — 2026-10-28

User contract: install Hive Mind, connect the intended Google account, choose the
existing brain or create a new one, and connect an AI. Users do not supply a
domain or manage a server. Drive remains canonical storage. The user is open to
creating a Google project for the product's setup. The current personal setup,
Composio connection and encryption keys stay intact until a qualified transition.

## Storage and execution

Drive stores encrypted canonical memory; it does not execute Hive Mind's search,
decryption, merge, scope enforcement or MCP code. Hosts with their own computer
can run the shipped plugin and existing joined service. Cloud-only hosts need
product-managed execution behind a stable authenticated MCP endpoint. An on-demand
service can do this without the user's PC being online. A Google Cloud project
can own OAuth registration and execution deployment; a custom user domain is not
an onboarding prerequisite. This is a target design, not a deployed service.

## Proposed first hosted implementation

Retain Composio as the connected-account layer. Check its supported custom OAuth
app/account-link flow before selecting direct Google OAuth code. Do not build a
Composio replacement. Register a dedicated product Google project/client when
required by the chosen connection flow. Evaluate Cloud Run or an equivalent
managed service; Cloud Run supports scaling to zero. The hosted service is an
execution/cache layer, never a second canonical memory database.

The hosted path must bind every request to authenticated user, exact Drive account,
brain instance/file/folder and permitted projects/tools. Local-bridge restrictions
are not sufficient authorization for a public service. Do not forward a desktop
administrator token to an AI host. An MCP host's OAuth connection and delegated
Google Drive authorization are separate trust boundaries, even if presented in
one guided flow. Protect consent state, redirect binding, PKCE, sessions,
refresh/revocation handling and per-account secret storage.

Use the smallest working Drive scope. Google recommends per-file drive.file for
files created/opened/shared with the app. Verify explicit selection/grant of the
existing canonical file; a new OAuth client does not inherit the old client's
file grants. Never silently seed over a current brain or request broad Drive
access to avoid implementing selection. Preserve conditional updates, bounded
conflicts, uncertain-write reconciliation, exact revision cleanup and Forget.

Encryption keys stay outside Drive and searchable memory. New-account onboarding
can provision an account-bound key into protected service storage; joining an
existing encrypted brain needs a verified key handoff from an authorized host.
A Google login alone cannot reconstruct its encryption key. Do not store keys in
plugin manifests or assume an OAuth project deploys the service automatically.
If compute instances are ephemeral, acknowledged writes must be durable in the
canonical Drive store; local cache/locks cannot substitute for conditional commit.

## Finite qualification before exposing Connect Google account

1. Inspect the actual product Google/Composio project and deployment access.
   Prepare concrete resources and required scopes. Preserve existing clients.
   Honor any required account/billing/provider consent at its real action point.
2. Deploy the smallest authenticated endpoint and account-link callback with
   protected durable secret storage. No unauthenticated memory access.
3. Prove two synthetic Google identities cannot cross-read/write or swap brain
   bindings. Test revoked/expired credentials, wrong scopes, invalid redirects,
   rotated keys, cold starts and concurrent requests.
4. Prove two native AI hosts share correction and Forget through Drive across
   service restarts, offline clients and conditional-write races. Verify erasure
   receipts rather than equating tombstones with cloud-history erasure.
5. Show the actual account-link flow end to end. Only then replace the manual
   configuration path for new users. Keep rollback and the existing personal
   connection until parity is demonstrated.

Current delivery is the local/native-host plugin, not this hosted onboarding.
No Google project, OAuth client, billable resource or public endpoint has been
created by the plugin work. These are engineering gaps, not missing user intent.

Sources: [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[Google OAuth web flow](https://developers.google.com/identity/protocols/oauth2/web-server),
[Cloud Run autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling).
