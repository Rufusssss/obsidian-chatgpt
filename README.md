# Obsidian ChatGPT MCP

A private, local-first ChatGPT plugin backend for interacting with one
configured Obsidian vault through the Model Context Protocol (MCP). ChatGPT is
the user interface; this project does not add an Obsidian plugin or an
Obsidian-hosted UI.

## Status

This repository contains a working read/write MCP server backed by a
recoverable Vault Service:

- Strict TypeScript configuration
- The official `@modelcontextprotocol/sdk` and Zod
- A validated environment configuration loader
- A dedicated vault path-policy boundary with typed, model-safe errors
- Recursive, deterministic Markdown note enumeration
- Exact UTF-8 note reads with byte metadata and SHA-256 revisions
- Bounded, deterministic literal title/content search with short snippets
- Bounded Obsidian-aware frontmatter, tag, heading, wikilink, and backlink
  metadata using an ephemeral local scan with no database
- Exactly eight MCP tools: `list_notes`, `search_notes`, `read_note`,
  `get_note_metadata`, `get_backlinks`, `create_note`, `append_to_note`, and
  `update_note`
- Strict Zod input and output schemas, structured results, safe errors, and
  truthful read/additive-write/destructive-write and closed-world annotations
- Stateful Streamable HTTP at `/mcp`, with bounded in-memory sessions and
  separate `/health` and `/ready` endpoints
- Unit and integration tests against invented temporary fixture vaults using
  Node's built-in TypeScript support and test runner
- Safe create, append, bounded exact-body update, optimistic revision checks,
  staged no-clobber commits, exact backups, crash journals, and local-only
  backup recovery in the Vault Service

Startup validates and canonicalizes the configured vault, then binds the MCP
endpoint to the configured loopback host and port. The exposed MCP surface can
read or safely mutate only policy-approved Markdown notes. It does not expose
custom UI, deletion, or systems outside the local vault.

See the project design before implementing later milestones:

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Tool contracts](docs/tool-contracts.md)
- [MCP local testing](docs/mcp-testing.md)
- [Write recovery](docs/recovery.md)

## Requirements

- Node.js 24 or newer
- npm 11 or newer

## Install

```bash
npm install
```

PowerShell may block the `npm.ps1` shim on systems with restrictive execution
policies. In that case, use `npm.cmd` in place of `npm`, for example:

```powershell
npm.cmd install
```

## Configure

Copy the example configuration to `.env` and replace the placeholder vault
path with the vault intended for manual development:

```powershell
Copy-Item .env.example .env
```

Do not use a real vault in automated tests. Tests copy the repository's
invented fixture into a fresh, marked operating-system temporary directory and
remove only that verified temporary root afterward.

| Variable | Required | Default | Validation |
| --- | --- | --- | --- |
| `OBSIDIAN_VAULT_PATH` | yes | none | Non-empty absolute path; validation does not access it |
| `MCP_HOST` | no | `127.0.0.1` | Must be `127.0.0.1`, `::1`, or `localhost` |
| `MCP_PORT` | no | `3000` | Integer from 1024 through 65535 |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error` |
| `BACKUP_DIR` | no | `.obsidian-chatgpt/backups` | Safe vault-relative directory; absolute/traversal paths are rejected |

`BACKUP_DIR` is relative to the configured vault. It may not escape the vault.
The write layer stores exact backups and content-free transaction journals
there; the directory is excluded from the normal note namespace.

## Commands

```bash
npm run dev
npm run mcp:start
npm run mcp:smoke
npm run mcp:test
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

- `npm run dev` validates `.env`, initializes the configured vault boundary,
  and starts the Streamable HTTP server in Node's watch mode.
- `npm run mcp:start` starts the TypeScript MCP server without watch mode for
  local Inspector testing.
- `npm run mcp:smoke` runs seven end-to-end protocol and security checks on an
  ephemeral loopback server backed only by a temporary synthetic vault.
- `npm run mcp:test` runs the focused Streamable HTTP MCP integration suite.
- `npm run typecheck` runs strict TypeScript checking without emitting files.
- `npm run lint` currently applies the same strict compiler checks without
  adding a separate lint dependency during the initial scaffold milestone.
- `npm test` runs the TypeScript tests with Node's built-in test runner.
- `npm run build` compiles `src/`, `scripts/`, and `tests/` into `dist/`.
- `npm start` starts the compiled MCP server.

On Windows with the PowerShell shim restriction, use `npm.cmd run ...` and
`npm.cmd test`.

## Configuration failures

Invalid configuration fails at startup with field-specific messages. Errors do
not echo configured paths or other values. For example, a relative vault path,
non-loopback host, privileged/out-of-range port, unsupported log level, or
traversing backup directory is rejected before the MCP server is created.

## Filesystem boundary

`src/vault/path-policy.ts` is the required entry point for resolving every
tool-facing note path. It:

- Accepts only `/`-separated vault-relative paths.
- Rejects POSIX, Windows drive, drive-relative, UNC, encoded, traversal,
  ambiguous, and reserved-device path forms.
- Allows only `.md` note targets.
- Denies `.obsidian`, `.trash`, dot-prefixed internal directories, and the
  configured backup directory.
- Canonicalizes the vault root and walks existing path components with
  `lstat`, rejecting symlinks, junctions, hard-linked files, and paths whose
  real location escapes the vault.
- Returns typed errors whose model-facing messages never contain the absolute
  vault path.

The policy supports safe directory resolution, component-by-component parent
creation, reserved recovery-directory setup, and explicit `existing`, `new`,
and `either` note expectations so reads and writes share the same boundary.
Callers must still re-resolve immediately
before filesystem use to protect the eventual operation from concurrent path
replacement.

## Vault service reads

`src/vault/vault-service.ts` provides `listNotes()`, `readNote(path)`,
and `searchNotes(query, options)`. It is a domain service, not an MCP tool
registration. Reads stream one size-limited file at a time, retain the note's
raw Markdown syntax, and calculate `sha256:<lowercase hex>` revisions over the
complete file bytes. Search is a bounded literal scan with no index,
embeddings, or vector database.

`getNoteMetadata(path)` detects bounded raw YAML frontmatter, common tag forms,
ATX headings, and outgoing wikilinks with aliases and conservative resolution.
`getBacklinks(path, options)` creates a fresh bounded in-memory index from
policy-approved notes. Duplicate filename-only targets remain ambiguous unless
exactly one matching note is local to the source folder. No persistent index,
database, embeddings, or Markdown/YAML rewriting is involved.

## Recoverable write layer

`ObsidianVaultService` implements `createNote`, `appendToNote`, and
`updateNote`; MCP exposes them as `create_note`, `append_to_note`, and
`update_note`. Append and update require the `version` from a prior `read_note`
call as `expected_revision`. Existing-note changes use stable SHA-256
revisions, same-directory staging, a no-clobber install, exact pre-write
backups in the reserved recovery directory, and content-free crash journals.
Append preserves all prior bytes; MCP update applies unique, non-overlapping
exact replacements outside YAML frontmatter and preserves untouched Markdown
bytes. The internal writer commits the resulting complete UTF-8 content
without parsing or reserializing it.

The local-only `recoverBackup` domain method restores a verified backup through
the same revision-checked update transaction and first backs up the live
version it replaces. See [Write recovery](docs/recovery.md) for the storage
layout, automatic crash outcomes, and recovery procedure.

## MCP endpoint

With the default configuration, connect an MCP client or MCP Inspector to:

```text
http://127.0.0.1:3000/mcp
```

The transport is stateful Streamable HTTP. Session IDs and pagination cursors
are random, memory-only, bounded, and expire. `/health` reports process health;
`/ready` reports whether the initialized server is accepting MCP traffic. The
SDK's localhost host-header protection is enabled, and configuration rejects
non-loopback bind addresses.

This is a private, single-user development endpoint. Secure MCP Tunnel support
is a later connection/deployment milestone; do not expose the server directly
on a LAN or public interface.

For the MCP Inspector command, representative tool calls, automated smoke
coverage, and disposable-vault setup, follow [MCP local testing](docs/mcp-testing.md).

## MVP boundaries

The implemented MCP surface exposes the five read and three write tools named
above. Deletion, an Obsidian plugin, custom ChatGPT UI, multiple vaults, and
vector search remain out of scope.
