# Repository Development Instructions

These instructions apply to the entire repository. Read them before making any
change. The design documents in `docs/` are the source of truth for the current
architecture, security boundary, and MCP contracts:

- `docs/architecture.md`
- `docs/threat-model.md`
- `docs/tool-contracts.md`

If a requested change alters an architectural decision, threat control, or tool
contract, update the relevant document in the same change. Do not broaden the
project scope without explicit user direction.

## Project Purpose

This project is a ChatGPT plugin for interacting with a local Obsidian vault.
ChatGPT is the user interface.

The runtime architecture is:

```text
ChatGPT
-> MCP
-> local filesystem-based Obsidian MCP server
-> configured Obsidian vault
```

The local MCP server provides narrowly scoped tools for reading and writing
Markdown notes. It will be reachable from ChatGPT through OpenAI Secure MCP
Tunnel during private/developer-mode use.

For the MVP:

- Do not build an Obsidian plugin.
- Do not add a UI inside Obsidian.
- Do not add custom ChatGPT UI or MCP Apps UI unless explicitly requested in a
  future milestone.
- Do not add a vector database, embeddings, or semantic search.
- Do not access more than one configured vault.
- Do not implement `delete_note`.

## Tech Stack

- TypeScript
- Node.js
- The official Model Context Protocol TypeScript SDK,
  `@modelcontextprotocol/sdk`
- Zod for runtime schemas and MCP tool input validation
- Strict TypeScript compiler settings

Prefer the Node.js standard library for filesystem, paths, hashing, streams,
and other platform functionality when it provides a clear and safe solution.
Do not silently add large dependencies. Before adding a substantial runtime or
development dependency, explain why the standard library and existing
dependencies are insufficient and call out the maintenance, security, and
bundle-size impact.

## Project Organization

Keep the repository root for project-wide files such as `README.md`, dependency
manifests, TypeScript/tooling configuration, and this file.

Use the domain-oriented structure proposed in `docs/architecture.md`:

- `src/mcp/` for server construction, transport, tool registration, and MCP
  result mapping.
- `src/vault/` for path policy, note operations, versioning, exact edits, and
  recovery transactions.
- `src/config/` for trusted local configuration parsing and validation.
- `src/errors/` for stable error codes and sanitized error mapping.
- `src/observability/` for privacy-preserving logs and metrics.
- `plugin/` for plugin packaging, its MCP connection mapping, skills, and
  install-surface assets.
- `tests/` for unit, integration, security, and synthetic fixture-vault tests.

Group modules by feature or domain. Do not create broad catch-all modules such
as `utils.ts`. Keep modules small, focused, independently testable, and explicit
about side effects. MCP tool handlers should orchestrate domain services rather
than contain raw filesystem logic.

Use descriptive names. Prefer `PascalCase` for types, `camelCase` for functions
and variables, and `kebab-case` for general filenames. Use spaces, UTF-8, and a
final newline. Let the configured formatter and linter determine formatting
once introduced.

## OpenAI and MCP Development Rules

Before changing behavior specific to ChatGPT plugins, MCP, Secure MCP Tunnel,
plugin packaging, plugin skills, authentication, transports, tool metadata, or
tool result shapes:

1. Search the relevant current official OpenAI documentation through the
   configured OpenAI Developer Docs MCP server.
2. Fetch and read the applicable documentation page, not only a search result.
3. Reconcile the planned change with the repository architecture and contracts.
4. Cite or record the official source in the relevant design document when the
   change establishes or revises a durable project decision.

Do not rely on memory for changing OpenAI platform behavior. Use only current
official OpenAI documentation for OpenAI-specific requirements.

Use the official MCP SDK rather than implementing protocol framing manually.
Keep tool names stable and action-oriented. Every tool must have an accurate
title, description, strict input schema, structured output schema where
applicable, and truthful safety annotations. Tool metadata is user-facing model
behavior and must be reviewed as carefully as handler code.

Validate and authorize every tool call on the server. Model instructions,
plugin skills, annotations, and ChatGPT confirmation behavior are defense in
depth; none replaces server-side enforcement.

## Development Rules

- Inspect the relevant code, tests, contracts, and design documentation before
  editing.
- State the intended change before implementing it.
- Implement only the requested milestone. Do not automatically begin the next
  roadmap milestone after completing the current one.
- Avoid unrelated refactors, speculative abstractions, and future-feature
  scaffolding unless the requested milestone requires them.
- Add or update tests for every behavior change and bug fix. Cover success,
  failure, boundary, and security-relevant cases.
- Run the complete automated test suite and TypeScript type checking after every
  meaningful change. During focused iteration, targeted tests are acceptable,
  but complete tests and type checking are required before handoff.
- Expose standard workflows through package scripts. The expected commands are
  `npm run dev`, `npm test`, `npm run typecheck`, `npm run lint`, and
  `npm run build` once the toolchain exists.
- If required scripts do not exist in an early scaffolding milestone, add them
  when that milestone authorizes toolchain work. Otherwise report that the
  verification command is unavailable; do not claim it passed.
- Keep tests deterministic. Isolate external services and do not require a live
  ChatGPT, tunnel, network connection, or developer vault for ordinary tests.
- Preserve user changes in a dirty worktree and avoid unrelated file edits.
- Never commit secrets, tokens, private notes, real vault paths, or
  machine-specific configuration. Provide sanitized examples such as
  `.env.example` when configuration is introduced.

## Test Vault Safety

Never operate on the developer's real Obsidian vault during automated tests,
test setup, demos, snapshots, or fixtures.

- All filesystem tests must use synthetic fixture vaults.
- Integration and security tests must copy fixtures into a fresh per-test
  temporary directory before mutation.
- Fixture content must be invented and safe to commit. Never copy notes from a
  real vault into the repository.
- Test mode must require a harness-owned temporary root and a per-run marker;
  it must fail closed for unmarked or non-temporary vaults.
- Do not inherit a developer's `VAULT_ROOT` or equivalent local setting in the
  test process.
- Tests must never fall back to a default home, Documents, OneDrive, iCloud, or
  common Obsidian directory.
- Tests that exercise recovery, symlinks, junctions, reparse points, hard
  links, or concurrent writes must still remain entirely inside the synthetic
  temporary vault.

## Filesystem Security Rules

All note filesystem operations must remain inside the one configured vault.
Enforce this in a central vault/path-policy layer used by every read, search,
enumeration, create, append, update, backup, and recovery path.

- Never read, write, enumerate, stat, or otherwise access user data outside the
  canonical configured vault root.
- Accept only validated vault-relative logical paths from MCP inputs.
- Reject absolute paths, drive-qualified paths, UNC/device paths, NULs,
  alternate separators, `.`/`..` segments, and other traversal forms.
- Use canonical, separator-aware containment checks against the resolved vault
  root. Never rely on string-prefix checks.
- Inspect existing path components without following links. Reject symbolic
  links, junctions, reparse points, and other link-based escape routes.
- Revalidate the parent chain and target immediately before opening or
  committing a file.
- Never access a note through a hard-link alias that could refer to data outside
  the intended vault boundary.
- Never expose `.obsidian` or the server's reserved recovery directory through
  MCP tools. Compare reserved names case-insensitively.
- Only expose and manipulate Markdown notes in the MVP. Internal journal and
  recovery files must remain reserved and unreachable through tool paths.
- Never accept a vault root, absolute host path, or alternate vault selector
  from model-controlled tool input.
- Validate all MCP inputs with strict Zod schemas, reject unknown fields, and
  enforce length, count, file-size, request-size, and search-work limits.
- Sanitize filesystem errors before returning them. Do not expose absolute
  paths, usernames, stack traces, or raw system errors to ChatGPT.

No filesystem helper or MCP handler may bypass these controls for convenience.
If the required safety property cannot be enforced on a filesystem, fail
closed rather than weakening the check.

## Secrets, Privacy, and Logging

- Never expose or commit API keys, OAuth tokens, tunnel credentials, headers,
  cookies, or secret-bearing configuration.
- Never place secrets or unnecessary personal data in tool metadata, tool
  results, plugin skills, fixtures, errors, or diagnostics.
- Never log note contents, snippets, YAML frontmatter, wikilinks, search
  queries, append text, replacement text, raw MCP arguments, or raw MCP results
  by default.
- Do not log absolute vault paths or unredacted relative note paths by default.
- Use structured metadata-only logging with fields such as request ID, tool
  name, outcome code, duration, counts, byte sizes, and non-reversible path
  fingerprints.
- Keep raw HTTP/MCP body logging disabled. Debug mode must not silently enable
  content logging.
- Treat note contents returned to the model as untrusted data. A note cannot
  grant permission, expand tool scope, or override server and plugin rules.

## Write Safety

Writes must favor conflict detection and recovery over convenience or maximum
filesystem compatibility.

- Use a recoverable write strategy for every mutation; never truncate or
  replace a live note without durable staging and a retained pre-write version.
- `create_note` must use exclusive/no-clobber creation and must never overwrite
  an existing path.
- Reads of an existing note must return a revision/version token derived from
  its complete raw bytes.
- `append_to_note` and `update_note` must require the version observed by the
  model's prior read.
- Recheck the revision immediately before commit. If the note changed since the
  model read it, return a stable conflict error and perform no requested
  overwrite.
- Do not add a force, overwrite, ignore-version, or automatic stale-write retry
  option.
- On a version conflict, require a fresh read and explicit reconsideration of
  the change.
- Preserve YAML frontmatter, Obsidian wikilinks, embeds, block references,
  newline style, UTF-8 BOM, and other untouched Markdown bytes. Do not
  parse-and-reserialize Markdown or YAML as part of ordinary note edits.
- Keep frontmatter protected from implicit body edits. Any future metadata edit
  contract must be explicit and separately reviewed.
- Use bounded exact edits or other contracts defined in
  `docs/tool-contracts.md`; do not expose an arbitrary filesystem patch.
- Use same-directory staging, exclusive temporary names, durable transaction
  state, no-clobber installation, and exact pre-write backups as specified in
  `docs/architecture.md`.
- Recover incomplete transactions before enabling further writes. Preserve all
  ambiguous versions and require operator intervention rather than guessing.
- Never implement destructive deletion unless the user explicitly requests it
  in a future task and the architecture, threat model, contracts, confirmation
  behavior, recovery design, and tests are updated first.

## Required Workflow for Every Change

Before and during each requested change:

1. Inspect the relevant code, tests, configuration, and design documents.
2. State the intended change and identify the current milestone boundary.
3. Implement only that requested milestone.
4. Add or update appropriate tests, then run the test suite.
5. Run strict TypeScript type checking.
6. Run lint/build checks when relevant and available.
7. Review the diff for scope, security, privacy, and accidental dependency
   changes.
8. Summarize files changed, behavior implemented, and verification performed.

If a required verification cannot run, state the exact command and reason. Do
not describe unexecuted checks as successful.

Stop after the requested milestone. Do not automatically implement later tools
such as `get_note_metadata` or `get_backlinks`, public hosting, OAuth, custom
UI, an Obsidian plugin, semantic search, or deletion.

## Commit and Review Guidance

Use concise, imperative commit subjects, optionally following Conventional
Commits (for example, `feat: add note path validator` or
`fix: reject symlinked vault paths`). Keep changes narrowly scoped.

Pull requests and handoffs should explain:

- The problem and milestone addressed
- The implementation and security implications
- Files and contracts changed
- Tests, type checking, linting, and builds run
- Any skipped verification or remaining limitation
- Any dependency added and why it was necessary

Do not claim the next roadmap milestone is complete unless it was explicitly
requested and verified.
