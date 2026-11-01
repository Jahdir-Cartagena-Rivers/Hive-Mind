# Native remote connector — offline preparation

This is a callable MCP adapter for the existing remote Hive Mind host and Drive
replica. It is not the instructions-only ZIP. No UI automation, Grok task, live
deployment, protected-key transfer or account change is performed by preparing it.

The user reports Auro can currently read Hive but cannot safely write updates.
Current source had a read-only adapter default, no headless adapter discovery
file and no per-tool Drive completion receipt. These are observed integration
gaps; the exact live cause is unverified because remote access is prohibited for
now. Do not label source tests as fixing Auro's current runtime. The mentioned
pay/relocation values were not supplied in this task and are not invented or
rewritten; Auro must reuse its exact user-supported pending answers when enabled.

## Prepare one native registration

On the target host, use its actual existing profile and reviewed source checkout:

```text
node scripts/prepare-remote-connector.mjs --profile /existing/absolute/profile --output /new/absolute/mcp-registration.json --access write
```

The script validates the opted-in existing configuration and emits a command
registration containing no tokens, passwords or keys. It does not install or
register the connector, contact providers, start processes or change the brain.
The command is the equivalent of:

```text
node /reviewed/source/scripts/remote-connector.mjs --profile /existing/absolute/profile --access write
```

Grok Bot's native command-based MCP registration should launch that command on
its own computer. Exact host-native registration and tool invocation remain to
be performed in one bounded task when authorized. Dot's actual supported native
connection must be handled separately; a local config file on Grok's computer
does not register anything in ChatGPT. No paid hosting is introduced.

## Safe writes and receipts

The adapter binds the profile's private connector-connection.json to its own
service-token. It does not use the Windows desktop connection or a global
default brain. The headless host publishes that private descriptor atomically.
An unrelated/read-only credential is never promoted by changing adapter settings.

Writes explicitly require --access write. Before a durable memory operation,
the adapter drains the existing Drive worker. Offline/conflicted/unready state
rejects before the fact is changed. A successful local mutation is followed by
another drain and a hiveWriteReceipt containing localCommitted, driveConfirmed
and state. Only a completed sync reports driveConfirmed:true. If the latter
flush fails or is uncertain, the response retains the local result and says not
to resubmit the write. Local canonical state and replica pending bytes retain
accepted changes across restart. Existing merge/conflict and conditional-write
semantics are preserved; this adapter never uploads a whole snapshot itself.

hive_mind_cloud_sync(action:status) reports the bound worker status.
hive_mind_cloud_sync(action:flush) retries synchronization without repeating a
memory write. Flush requires write access. It does not bypass a conflict or
invent a new credential. The worker's drain handles changes queued during an
older active pass, preventing an old result from confirming an unsent new write.
An unusually busy drain returns pending after four passes rather than claiming
success indefinitely. Forget retains the existing revision-cleanup protocol.

The on-demand launcher attaches to an existing coordinated host. If a previously
stopped host left a stale descriptor, it can start that same opted-in profile
under the host's ownership lock. A live old host without the new coordinator
must receive one controlled code update; the adapter refuses a second owner.
Closing an attached connector does not terminate the existing host. Closing a
connector-owned host drains shutdown and releases ownership. The native app can
launch the registered command again after reboot, without another manual daemon.
Actual native app restart/autostart remains deployment qualification, not proven
merely by local lifecycle tests. The existing protected credential environment
must be available to the host; missing credentials remain a specific runtime gap.

## Qualification completed locally

Synthetic fixture tests cover read/write, correction, Forget, token/project
rejection, offline preflight, retained local write with failed shared flush,
sync-only retry, scheduler drain race, attach/close and stopped-host recovery.
An independent two-client test uses actual encrypted CloudFileReplica archives,
conditional writes and old-revision cleanup against an in-memory Drive transport.
No real Drive or applicant data is touched. A separate child-process test
executes the actual native command and verifies initialization produces only MCP
JSON on stdout, and registration preparation contains no token. Native registration and live
Grokbot/Dot write receipts remain unverified until remote use is authorized.
