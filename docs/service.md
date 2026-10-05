# Standalone service

Install Node.js 24.13 or newer, then run `npm ci --ignore-scripts`. The runtime
dependencies are the same Effect and YAML versions already used by the J1 core.
No model, browser, or Hindsight installation is performed automatically.

In PowerShell, create a token in the current process and start a separate state
directory:

```powershell
$env:HIVE_MIND_TOKEN = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
npm start -- --state-dir C:\Knowledge\HiveMindStandalone --port 8788
```

Provide that token to authorized clients through their secure credential storage.
Do not put it in a URL, repository, or command argument. Optional
`HIVE_MIND_READ_TOKEN` grants status/search access without mutation permission.
The server binds to loopback and rejects browser-origin requests. Remote access
requires a separately configured authenticated proxy; no public listener is
enabled by default.

All `/v1` operations require `Authorization: Bearer <token>`. POST requests use
`Content-Type: application/json` with at most 64 KiB of JSON. `/health` returns
only readiness and product identity without authentication.

| Method and path      | JSON body / behavior                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| GET `/v1/status`     | Configuration and synchronization status.                                                      |
| POST `/v1/search`    | `query`, optional `project`; returns current facts and revisions.                              |
| POST `/v1/remember`  | `scope`, optional `project`, `subject`, `fact`.                                                |
| POST `/v1/edit`      | `id`, `revision`, `fact`; a stale revision returns 409.                                        |
| POST `/v1/forget`    | `id`; records a durable forget operation.                                                      |
| POST `/v1/configure` | Configuration version 1 with optional vault, Hindsight, skills, automatic, localEngine fields. |
| POST `/v1/sync`      | `{}`; waits for the current synchronization drain.                                             |
| POST `/v1/import`    | `url`, `bank`; explicit read-only import of an original Hindsight source bank.                 |

For configuration examples see `examples/hive-mind.config.example.json`. Paths
belong to the service host and must be absolute. Vault notes can be edited in
Obsidian after configuration. Skills are cataloged rather than executed. Local
engine recovery, if explicitly configured, reuses the existing installation.

The standalone service refuses installed `.j1`/`.t3` paths, symlinked state paths,
or directories with an application state database/settings file. It does not
migrate J1 data automatically. Keep its state and vault dedicated to this service.
Stop with Ctrl+C; restart with the same state directory to preserve records.

J1's current settings, provider tools, and Dot memory route continue using the J1
edition. They are not silently redirected to this standalone service. The HTTP
API is available to clients that explicitly choose this separate deployment.
