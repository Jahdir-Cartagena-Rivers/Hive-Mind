# Synthetic examples

Everything in this folder is invented demonstration data. It contains no real conversation, imported account memory, database, credential, or source-bank export.

`canonical-memory.example.json` shows a project-scoped decision for the fictitious Nebula project. The managed Markdown example under `vault/Hive Mind` was generated from that record using the implementation's vault adapter. Its ID and fingerprints match the example record.

## Follow a correction

Open the Markdown file and change **copper** to **aluminum** in its body. Keep the frontmatter intact. In a configured J1 environment, synchronization compares the note's base fingerprint with canonical memory before applying the edit. A newer canonical correction would produce a conflict and preserve the edited file for review.

The note's frontmatter is managed metadata, not another place to edit project scope or source identity. The `canonical-memory.example.json` file is a format example; production memory should be changed through Hive Mind's operations.

## Configure a sandbox

`hive-mind.config.example.json` uses illustrative absolute Windows paths and a dedicated demonstration bank. Adapt those paths to your server and save the setup through J1's Hive Mind settings. Do not point tests at an installed user's live userdata.

`skills/thermal-review/SKILL.md` is a tiny illustrative skill. Adding its parent folder to the catalog makes its name and description searchable. The catalog does not execute the instructions.

For the actual service and tests, use the linked [J1 Code implementation](https://github.com/Jahdir-Cartagena-Rivers/J1Code/tree/d709391df467a41c08c4b39767868b3808ce4666/apps/server/src/hiveMind).
