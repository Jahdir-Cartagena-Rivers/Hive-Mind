# Connect an AI to Hive Mind

Hive Mind 0.6.0 includes a stdio MCP plugin for AI apps running on the same host
as Hive Mind. It uses the existing service and private connection file; it does
not create another memory store or put credentials in the plugin package.
Requires Node.js 24.13+ on the AI client's PATH and a running Hive Mind service.

## Guided desktop setup

In **Settings → Connect an AI**, choose read-only or read/write, then choose all
projects or enter exact project names, one per line. General facts are separately
opt-in for selected-project connections. Use **Check connection**, then **Export
plugin** and select a parent folder. Hive Mind creates a new folder and opens it.
Follow its `START_HERE.txt`; no existing AI configuration is overwritten.

Selected-project connections expose only fact recall/save/forget tools. Results
are filtered even if the service ranks facts from another project. Task, context,
presence, status and reference tools are hidden to prevent cross-project links
from escaping that view. All-project connections retain those tools. Read-only
connections hide fact writes and constrain mixed-action tools to reads.

These are connector restrictions, not separately scoped service credentials.
A process that can read the private connection file can bypass the adapter; use
the service's separate read-only credential for a service-enforced read boundary.
The plugin's skill instructions guide use; they do not override the AI host's
permissions, certification gates or the current user's instructions.

## Repository installation

Codex:

```text
codex plugin marketplace add https://github.com/Jahdir-Cartagena-Rivers/Hive-Mind.git
codex plugin add hive-mind@hive-mind
```

Claude Code:

```text
claude plugin marketplace add https://github.com/Jahdir-Cartagena-Rivers/Hive-Mind.git
claude plugin install hive-mind@hive-mind
```

Restart or reload plugins as requested by the host. Repository installs default
to read-only and discover `~/.hive-mind/connection.json` on the AI host. For
custom settings, export a configured package instead. `HIVE_MIND_CONNECTION_FILE`
selects a private host connection; `HIVE_MIND_CONNECTOR_CONFIG` selects a private
connector settings file. Both are file paths, never credential values.

## Portable package / source export

Download `Hive-Mind-Plugin-0.6.0.zip` from the release and extract it before use.
The package includes manifests, the MCP bridge, shared-memory skill, license,
Codex marketplace metadata, generic MCP configuration and a start-here guide.
Or export a new folder from source:

```text
node scripts/export-plugin.mjs --output C:/Knowledge/Hive-Mind-Plugin --access write --project Nebula
```

Repeat `--project` for more projects; `--include-general` permits general facts.
Omit projects for all-project access. Add `--connection-file <absolute-path>` for
a private host connection. Existing output folders are rejected. A partial export
after an I/O failure is not accepted; choose a new folder to retry.

The guide includes native installation commands. Claude can also load the folder
with `claude --plugin-dir <folder>`. Generic MCP clients use `mcp.local.json`;
Codex can use the MCP entry in `codex.toml` instead of a plugin. Keep the package
in its chosen location when using those absolute-path configurations.

Run `node <folder>/runtime.mjs --check` to verify discovery and authentication.
Then ask the host to recall a known fact. Test a synthetic fact's save, correction
and forget in two clients before relying on write automation. Every tool request
reads the service directly; no memory cache can keep an old correction alive.
Unknown or interrupted writes must be reconciled before retry; no automatic
write retry occurs. Errors do not echo connection credentials or HTTP bodies.

## Another computer or cloud AI

An AI with its own computer can run the same plugin beside its own Hive Mind host.
First join that host to the existing encrypted store using the protected
[Drive sync setup](drive-file-sync.md). Keep encryption keys and credentials
outside the plugin and outside Drive. A desktop export is bound to that desktop's
connection-file path; re-export without that path or configure the new host's
private connection file. Exporting a plugin does not join a host or sync memory.

Cloud-only hosts that cannot execute stdio need product-managed execution behind
an authenticated HTTPS MCP connection. The intended setup is connect Google
account; users should not need their own domain or hosting account. See the
[account-connect implementation plan](ACCOUNT-CONNECT-PLAN.md).
This release does not expose a public listener, implement public
OAuth onboarding or provision a Google Cloud/OAuth project. The adapter accepts
an explicitly configured HTTPS `/mcp` endpoint and refuses redirects and remote
plain HTTP. Public host compatibility and authorization are separate qualification.

## Qualification

`npm run test:plugin` verifies independent exported processes sharing corrections,
forget and restart, read-only rejection, scope filtering, auth rejection,
neighboring continuity tools, safe output and non-overwriting export.
`npm run qualify:plugin-hosts` runs installed Codex and Claude binaries against a
synthetic service with temporary host profiles. It checks Claude plugin loading
and health and native Codex plugin discovery/write/readback without a model turn.
`npm run test:desktop` exercises actual renderer/IPC connection checking, empty
project rejection and export alongside existing continuity/visual workflows.

Packaging follows [OpenAI's plugin documentation](https://developers.openai.com/plugins/build/plugins)
and [Claude's manifest reference](https://code.claude.com/docs/en/plugins-reference).
Native host checks and tool roundtrips do not establish spontaneous model recall
or unattended saving. Those remain host-specific runtime observations.
