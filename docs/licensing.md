# Licensing and publication boundaries

This repository is source-available. New original, copyrightable service material
is reserved under LICENSE; public visibility does not grant a general reuse
license. Applicable legal exceptions and GitHub's viewing/forking terms remain.

The engine in src/legacy is an adaptation of code already released under MIT in
J1Code. It remains MIT, as do its import-path adaptations. The provenance manifest
records the source paths, commit, and fingerprints. Third-party packages retain
their own licenses. Unchanged synthetic examples and earlier showcase versions
remain MIT. No permission already granted is withdrawn.

J1Code and its existing downloads stay public. Its new protected contributions
now follow its own reserved-rights terms, while upstream and previously MIT
material keep their permissions. Moving copies here does not make
the earlier J1 implementation exclusive. A J1-only check would be removable by
someone with source access and would not change those MIT permissions.

Before publishing, run npm run check:publication. The check audits tracked files
and reachable Git history, rejects unexpected paths and binary payloads, checks
synthetic fixtures, and scans common credential formats. It is a publication
guard, not a guarantee that every possible secret will be detected. Do not add
live memory, profiles, vaults, account exports, credentials, logs, installers,
application bundles, or source maps.

Copyright protects eligible expression rather than ideas or behavior. AI-assisted
work requires a review of human authorship and ownership; the notice itself does
not establish exclusive rights. Obtain an IP lawyer's review before commercial
enforcement or accepting rights-sensitive contributions.
