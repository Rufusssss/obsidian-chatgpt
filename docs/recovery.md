# Write recovery

Status: MCP create/append/update and Vault Service recovery implemented; no MCP restore tool  
Applies to: `create_note`, `append_to_note`, `update_note`, their Vault Service
methods, and local-only `recoverBackup`

## Safety boundary

All write paths first pass `VaultPathPolicy`. Callers provide only a
vault-relative Markdown path. The writer revalidates parent directories and the
target before commit, rejects links and hard-linked live notes, and never
accepts the backup directory as a note path.

The configured `BACKUP_DIR` is a reserved directory inside the one configured
vault. Its default is `.obsidian-chatgpt/backups`. It is excluded from listing,
search, reads, and all tool-facing note paths, so backups remain outside the
normal note namespace. MCP write results do not expose backup IDs, and no MCP
method exposes recovery operations.

## Normal write sequence

All writes are serialized inside one Vault Service process. Cross-process and
external editor races are handled by revision rechecks and exclusive/no-
clobber filesystem operations; the project assumes only one MCP server process
owns a configured vault.

### Create

1. Validate the logical Markdown path.
2. Walk and create missing parent folders one component at a time. Every
   existing or newly created component is checked for links and canonical vault
   containment.
3. Write the complete UTF-8 bytes to an unpredictable same-directory staging
   file opened with exclusive creation, then flush the file.
4. Record a content-free transaction journal.
5. Revalidate that the target is still absent.
6. Install the staging file with a hard-link no-clobber operation. If the target
   appeared, creation fails without replacing it.
7. Remove the staging name, flush the directory where supported, and remove the
   journal.

Creation has no backup because there was no prior note. A crash cannot expose a
partially written target: it can leave only the complete target or an internal
staging file that recovery removes.

### Append and update

1. Read a stable raw UTF-8 snapshot and calculate its SHA-256 revision.
2. Check the supplied revision. The MCP append and update contracts always
   require it. The internal `appendToNote` method also supports a local-only
   optional form that appends to a stable snapshot and rechecks it at commit.
3. Build the exact intended bytes in memory. Append concatenates bytes without
   adding delimiters or rewriting existing text. Update encodes exactly the
   complete content supplied by the caller. Neither operation parses or
   serializes Markdown, YAML, wikilinks, or line endings.
4. Write and flush an unpredictable same-directory staging file and verify the
   filesystem supports hard-link no-clobber installation.
5. Create and flush the backup described below before moving the live note.
6. Create and flush a content-free transaction journal.
7. Read and hash the live note again. A mismatch returns `VERSION_CONFLICT` and
   leaves the live note unchanged.
8. Move the current live name to the transaction's recovery name, hash the
   captured bytes again, and reject/restore on a mismatch.
9. Install the complete staging file at the live name with the no-clobber hard
   link. A competing file is never replaced.
10. Move the captured prior file into its backup entry, flush directories where
    supported, and remove the journal.

On filesystems that cannot supply the required no-clobber primitive, writes
fail with `UNSAFE_FILESYSTEM`; the code does not fall back to truncating or
unchecked replacement. Directory flushing is best-effort only for the specific
platform errors that mean directory `fsync` is unsupported. File data and
journals are always explicitly flushed.

## Backup layout

Each modification of an existing note creates an opaque UUID backup ID and a
directory under `BACKUP_DIR`:

```text
BACKUP_DIR/
├── backup-<uuid>/
│   ├── manifest.json
│   ├── note.md
│   └── captured.md
└── transaction-<uuid>.json
```

- `note.md` contains the exact stable pre-write bytes and is flushed before the
  live note name is moved.
- `manifest.json` contains format version, backup ID, vault-relative note path,
  SHA-256 revision, byte size, and creation timestamp. It contains no note
  text.
- `captured.md` is the original filesystem object moved away from the live
  path during commit. Normally it matches `note.md`; retaining it also preserves
  bytes if an external application held that file open during the transaction.
- `transaction-<uuid>.json` contains only paths/names, revisions, operation,
  and backup identity needed for crash recovery. It contains no note content.

Backups from successful writes and safely aborted conflicts are retained. This
milestone does not automatically prune them. Operators must include the
reserved directory in vault storage planning and must not edit it while the
server is running.

## Automatic interrupted-transaction recovery

Before every Vault Service write, pending journals are validated and recovered.
Reads remain available because the recovery directory is never enumerated as
notes.

Recovery uses hashes and filesystem identity rather than timestamps:

- If the intended live version is installed, recovery removes a matching
  leftover staging name, preserves the captured prior file in the backup, and
  completes the journal.
- If the old live version is still present and no capture occurred, recovery
  discards only the transaction's staging name and completes the journal.
- If the live name is missing and the captured file has the expected revision,
  recovery restores it with a no-clobber link, then removes staging and the
  journal.
- If both live and captured names are missing, recovery reconstructs the old
  live note from the verified exact backup using exclusive creation.
- If names, hashes, links, manifests, or identities do not form one of those
  unambiguous states, all versions are preserved and writes fail with
  `RECOVERY_REQUIRED`. The implementation never guesses which version wins.

## Restoring a completed backup

`ObsidianVaultService.recoverBackup(backupId, expectedRevision)` is a local
domain operation only. It is intentionally absent from MCP.

Recovery is itself a safe update:

1. Validate the opaque backup ID and manifest.
2. Verify the backup byte size and SHA-256 revision.
3. Decode the exact backup as UTF-8 without removing a BOM.
4. Require the revision of the current live note. A stale revision returns
   `VERSION_CONFLICT`.
5. Install the backup content through the normal update transaction.
6. Back up the version being replaced, so restoring an older version never
   destroys the current one.

After recovery, read the note again and compare its returned revision to the
revision in the recovered backup manifest. There is currently no command-line
restore command and no MCP restore tool; an operator-facing recovery command
requires a separate reviewed milestone.
