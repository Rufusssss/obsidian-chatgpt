# Architecture

Status: eight-tool MCP server with Obsidian metadata and recoverable writes implemented  
Last verified against official OpenAI documentation: 2026-08-20

## 1. Decision summary

The MVP is a private, local-first ChatGPT plugin backed by a Node.js/TypeScript
MCP server. ChatGPT remains the only user interface. The architecture defines
eight focused tools and access to exactly one configured Obsidian vault. The
MCP surface exposes five reads plus safe create, revision-checked append, and
revision-checked exact body updates backed by the recovery layer. It does not
add UI resources, an Obsidian plugin, a vector database, or a delete tool.

The runtime path is:

```text
ChatGPT conversation
        |
        | MCP tool selection and calls
        v
OpenAI Secure MCP Tunnel endpoint
        |
        | outbound-only tunnel-client connection
        v
127.0.0.1:<configured port>/mcp
        |
        | official MCP TypeScript SDK, Streamable HTTP
        v
Vault policy and note services
        |
        | constrained filesystem operations
        v
One configured Obsidian vault
```

Secure MCP Tunnel is a development/private-distribution mechanism, not a path
to public plugin submission. A future public plugin would require a stable,
public HTTPS Streamable HTTP endpoint and a different product architecture for
reaching each user's local vault. That is explicitly outside this MVP.

## 2. Verified OpenAI platform constraints

The following current platform facts shape the design:

- A plugin may contain skills, an MCP server, or both. Custom UI is optional;
  MCP tools can return structured data and model-readable content without a UI.
- OpenAI recommends the official `@modelcontextprotocol/sdk` package with Zod
  for TypeScript MCP servers. Tool definitions should include stable names,
  titles, descriptions, explicit input schemas, output schemas, and accurate
  safety annotations.
- Production MCP endpoints use Streamable HTTP, typically at `/mcp`. MCP
  Inspector should be used before connecting the server in ChatGPT developer
  mode.
- Secure MCP Tunnel lets `tunnel-client` reach a private stdio or HTTP MCP
  server through outbound HTTPS. It requires a `tunnel_id`, a runtime API key,
  correct Platform/ChatGPT workspace association, and appropriate tunnel and
  developer-mode permissions.
- Secure MCP Tunnel supports private/developer-mode connections but does not
  satisfy public plugin submission requirements.
- Every packaged plugin has `.codex-plugin/plugin.json`. A registered MCP
  connection can be referenced through `.app.json`; skills live below
  `skills/`.
- Skills are static workflow instructions. They are appropriate for tool
  sequences and conflict handling, while live data and authorization stay in
  the MCP server. Skills imported from an MCP server are submission-time
  snapshots, not runtime content.

Official sources:

- [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Define tools](https://developers.openai.com/plugins/plan/tools)
- [MCP server concepts](https://developers.openai.com/plugins/concepts/mcp-server)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Build skills](https://developers.openai.com/plugins/build/skills)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Authentication](https://developers.openai.com/plugins/build/auth)

## 3. Scope

### MVP capabilities

Read tools:

- `list_notes`
- `search_notes`
- `read_note`
- `get_note_metadata`
- `get_backlinks`

Write tools:

- `create_note`
- `append_to_note`
- `update_note`

Explicitly excluded:

- `delete_note`
- Custom ChatGPT UI or MCP Apps UI resources
- An Obsidian plugin or any UI embedded in Obsidian
- A vector database, embeddings, or semantic indexing
- Non-Markdown attachments and files
- Public plugin publication through Secure MCP Tunnel
- Multi-vault access

## 4. Component design

### 4.1 ChatGPT plugin package

The plugin package gives the integration a stable identity and connects the
registered ChatGPT MCP connection to the package. It contains:

- `.codex-plugin/plugin.json` for identity and install-surface metadata.
- `.app.json` for the registered ChatGPT MCP connection created in developer
  mode. The environment-specific technical connection ID is added only after
  the tunnel-backed server is registered.
- One focused `obsidian-vault-notes` skill. It describes the read-before-write
  sequence, passing `expected_revision`, handling conflicts, and treating note
  contents as untrusted data. It contains no vault data or credentials.
- Branding assets only if needed for packaging. There is no component UI.

The skill complements but never replaces server enforcement. Tool descriptions
and the server initialization instructions carry the critical rules even when
the skill is not active. The most important initialization instructions should
fit in the first 512 characters, as recommended by the OpenAI MCP guidance.

### 4.2 Secure MCP Tunnel

`tunnel-client` runs under the same local OS account and trust boundary as the
MCP server. It connects outward to OpenAI and forwards requests to the server's
loopback-only Streamable HTTP endpoint.

Operational rules:

- Never bind the MVP endpoint to a non-loopback interface.
- Keep the tunnel runtime API key outside the repository and logs.
- Associate the tunnel only with the intended Platform organization and
  ChatGPT workspace.
- Require Tunnels Read + Use for operators; Tunnels Read + Manage is needed to
  create or edit the tunnel.
- Treat a shared workspace/plugin connection as access to the configured local
  vault. Do not share it beyond the intended user in the MVP.
- Use `tunnel-client doctor`, health/readiness endpoints, and MCP Inspector for
  diagnostics without enabling raw body logging.

### 4.3 MCP transport and server

The service uses Node.js, TypeScript, `@modelcontextprotocol/sdk`, and Zod.
It exposes a Streamable HTTP endpoint at `/mcp`, bound by default to
`127.0.0.1`. The endpoint is session-capable, but no filesystem or transaction
state depends on an MCP session; session IDs are random, memory-only, and
expire after a short idle timeout. The implemented transport caps concurrent
sessions, uses the official SDK's localhost host-header protection, and exposes
content-free `/health` and `/ready` endpoints separately from MCP.

The server has four layers:

1. **Transport:** Streamable HTTP framing, lifecycle, request size limits,
   session management, and health/readiness.
2. **MCP contracts:** tool metadata, Zod schemas, result shaping, and safe error
   mapping.
3. **Vault domain:** path policy, note enumeration/search/read, optimistic
   concurrency, exact text edits, and recovery transactions.
4. **Filesystem adapter:** the only layer allowed to call filesystem APIs for
   vault data.

Handlers never accept an absolute filesystem path. They receive a
vault-relative logical note path and call the vault policy for every operation.

### 4.4 Vault boundary

At startup, the server accepts one `vaultRoot` from trusted local
configuration, resolves it to an absolute real path, verifies it is an existing
directory, and rejects a symlink/junction/reparse-point root. The resolved root
is immutable for the lifetime of the process.

Every requested note path must pass all of these checks:

1. It is a non-empty, vault-relative logical path using `/` separators.
2. It contains no NUL, drive prefix, UNC prefix, URL encoding step, absolute
   form, `.` or `..` segment, empty segment, Windows alternate-data-stream
   colon, or reserved device basename.
3. It ends in `.md` (case-insensitive for validation) and resolves to a regular
   file for read/update operations.
4. No segment is `.obsidian` or the reserved internal directory
   `.obsidian-chatgpt`, compared case-insensitively.
5. Every existing path component is inspected with `lstat`; symbolic links,
   junctions, and other reparse points are rejected rather than followed.
6. The real path of an existing target, or the real path of the nearest
   existing parent for a create, remains within the canonical vault root using
   a separator-aware containment check.
7. A note with a hard-link count greater than one is rejected. This prevents an
   in-vault hard link from aliasing a file outside the vault.
8. The parent chain and target are revalidated immediately before a read or
   commit.

Enumeration uses the same policy. It never follows directory links and skips
`.obsidian` plus `.obsidian-chatgpt` before descending.

The policy is deliberately stricter than normal Obsidian behavior. A note that
is reachable only through a link is not available to the plugin.

### 4.5 Note representation

Notes are valid UTF-8 Markdown files. The server treats their content as text,
not as an abstract Markdown syntax tree:

- Wikilinks such as `[[Note]]`, aliases, embeds, and block references are not
  parsed or rewritten.
- Newline style and a UTF-8 BOM, when present, are preserved for untouched
  content.
- `append_to_note` appends exactly the supplied text after the existing final
  byte and does not invent a newline.
- `update_note` applies bounded, exact, non-overlapping replacements located
  against the original Markdown body. It rejects edits to leading YAML
  frontmatter and preserves every untouched byte.

`create_note` accepts the complete initial Markdown text and may therefore
include new YAML frontmatter. The server makes no implicit metadata changes.

### 4.6 Bounded lexical search and link indexing

`search_notes` performs a bounded, case-insensitive literal scan by default.
It does not accept regular expressions and does not build persistent indexes,
embeddings, or a vector database. The scan:

- Enumerates only policy-approved Markdown notes.
- Uses streaming reads so a vault is not loaded into memory.
- Stops at configured file, byte, result, and deadline limits.
- Returns small excerpts with line numbers, never whole matching files.
- Uses opaque pagination cursors tied to the normalized query and scope.

This keeps the MVP inspectable and private. A later lexical index may be
considered if measured vault sizes require it, but semantic/vector search is
not part of this architecture.

`get_note_metadata` uses a small, read-only lexical parser rather than a full
Obsidian implementation. It detects leading YAML frontmatter boundaries,
bounded raw frontmatter and simple top-level keys, common scalar/list `tags`
forms, inline tags, ATX headings, and Obsidian wikilinks with optional aliases.
Fenced and inline code are excluded. It never parses and reserializes YAML or
Markdown and never modifies note bytes.

Outgoing wikilinks are resolved only against the policy-approved note-path
list. Explicit vault-relative paths resolve directly. A filename-only target
resolves when unique, or when exactly one duplicate is in the source folder;
otherwise it remains `ambiguous`. Missing targets remain `missing`. This is a
conservative, deterministic subset of Obsidian resolution, not an attempt to
replicate every alias, normalization, embed, or link-resolution rule.

`get_backlinks` builds an ephemeral in-memory link index for each call by
scanning policy-approved Markdown notes within the same file and byte work
limits as lexical search. Only resolved wikilinks are attributed to a target;
ambiguous and nonexistent targets are not guessed. Results and per-note link
counts are bounded, carry source revisions, and expose truncation explicitly.
No database or persistent index is created.

## 5. Concurrency and safe writes

### 5.1 Version tokens

Every read result includes an opaque version token formatted as
`sha256:<lowercase hex>`, calculated over the complete raw note bytes. File
timestamps are returned as metadata but are never used as the concurrency
authority.

- The MCP tools `append_to_note` and `update_note` require
  `expected_revision`, populated with the `version` from `read_note`.
- The internal `updateNote` method requires a revision. The requested
  `appendToNote` service API accepts an optional revision; when omitted it
  appends to a stable snapshot acquired inside that call and rechecks the same
  snapshot immediately before commit. This optional form is not an MCP
  contract.
- A mismatch returns `VERSION_CONFLICT` and performs no requested mutation.
- `create_note` uses exclusive create semantics and returns `ALREADY_EXISTS`
  rather than overwriting.
- ChatGPT must reread after a conflict; it must not silently retry with a new
  version.

### 5.2 Recovery transaction

Mutations use a durable, recoverable transaction inside the vault. The
reserved `.obsidian-chatgpt/` directory is never exposed by tools. It contains
transaction journals and versioned backups because all vault-related data must
remain inside the configured vault.

The implemented Vault Service append/update sequence is:

1. Acquire the service's in-process write mutex and recover pending journals.
2. Revalidate the path and compare the raw-byte hash with the expected
   revision.
3. Build the new bytes in memory within configured size limits.
4. Write and `fsync` an unpredictable same-directory staging file opened with
   exclusive-create flags.
5. Write and `fsync` an exact pre-write backup, then a content-free transaction
   journal.
6. Revalidate and move the current note to an unpredictable recovery name.
   Hash the moved bytes; if they differ from the expected revision, restore them
   without clobbering another file and return `VERSION_CONFLICT`.
7. Install the staged file with an atomic no-clobber primitive (for example, a
   same-filesystem hard link followed by removal of the staging name). If a
   file appeared at the destination, do not replace it; preserve all versions
   and return a conflict.
8. `fsync` affected directories where the platform supports it, move the
   recovery copy into the reserved backup store, mark the journal complete,
   and return the new version and opaque backup ID.

Before every Vault Service write, incomplete journals are recovered. All three
MCP write tools use this same fail-closed gate.
If the filesystem cannot supply the required exclusive/no-clobber semantics,
read tools remain available but write tools fail closed with
`UNSAFE_FILESYSTEM`; the implementation must not fall back to an unchecked
overwrite.

Backups retain the exact pre-write bytes and relative note identity. Automatic
retention pruning is not implemented in this milestone, so backups are retained
until a separately reviewed retention feature is added. There is no MCP restore
or delete tool. The local-only Vault Service recovery method requires the
current live revision and backs up the version it replaces. See
[Write recovery](recovery.md) for the exact layout and recovery procedure.

This design prioritizes preventing data loss over making every filesystem
configuration writable. A malicious process already running as the same OS
user is outside the security boundary because it can access the vault directly;
the server still minimizes race windows and preserves observed competing
versions.

## 6. Authentication and authorization posture

The MVP is single-user and private:

- The MCP listener is loopback-only.
- `tunnel-client` and the MCP server run as the OS user who owns the vault.
- The tunnel is restricted to the intended ChatGPT workspace and operator.
- The configured vault root is the only authorization scope; there is no tool
  parameter that can select another vault.

The tunnel authenticates its control-plane connection, but it is not a general
replacement for end-user OAuth in a shared or public service. The MVP must not
be exposed on a LAN, shared broadly in a workspace, or submitted publicly. If
the server ever becomes remotely reachable or multi-user, OAuth 2.1 conforming
to the MCP authorization specification, per-tool read/write scopes, token
verification, and user-to-vault authorization are prerequisites—not follow-up
hardening.

## 7. Logging and privacy

Default logs are structured and metadata-only. They may contain:

- Request/correlation ID
- Tool name
- Outcome/error code
- Duration
- Result count and byte count
- A process-salted fingerprint of the relative path

They must not contain:

- Note contents, excerpts, YAML, wikilinks, or search queries
- Raw MCP arguments or results
- Absolute vault paths or unredacted relative paths by default
- Tunnel API keys, OAuth tokens, headers, or environment dumps

Debug content logging is not implemented in the MVP. Error messages returned
to ChatGPT use relative logical paths only and do not reveal the host username
or absolute filesystem layout.

Reading a note necessarily sends the requested content to ChatGPT through the
MCP result. Operators must treat ChatGPT workspace data controls and plugin
invocation logging as part of the data boundary; the secure tunnel protects
transport reachability, not the confidentiality of data deliberately returned
to ChatGPT.

## 8. Configuration

Configuration is local, validated once at startup, and never exposed as an MCP
tool.

| Setting | Default | Rule |
| --- | --- | --- |
| `vaultRoot` | none | Required absolute path from trusted local config |
| `host` | `127.0.0.1` | Non-loopback values rejected in the MVP |
| `port` | operator-selected | Must be an unprivileged local port |
| `maxNoteBytes` | 1 MiB | Applies to reads and post-write size |
| `maxRequestBytes` | 256 KiB | Bounds MCP request bodies |
| `searchMaxFiles` | 10,000 | Hard scan ceiling |
| `searchMaxBytes` | 100 MiB | Hard scan ceiling |
| `searchDeadlineMs` | 10,000 | Monotonic deadline |
| `backupVersionsPerNote` | planned | Retention pruning is not implemented |
| `backupRetentionDays` | planned | Retention pruning is not implemented |
| `includeObsidianConfig` | `false` | Fixed false for MVP tools |
| `logLevel` | `info` | Never enables content logging |

Secrets are supplied through the tunnel client's environment or OS secret
management and are not part of the MCP server's plugin package.

## 9. Testing strategy

Automated tests never point at a user's real vault.

- Each integration/security test creates a synthetic vault beneath the test
  runner's temporary directory and adds a unique marker file.
- In test mode, server startup refuses any vault root that is outside the
  temporary test root or lacks that marker.
- Repository fixtures contain invented notes only. Tests copy fixtures into a
  fresh per-test vault and never mutate the fixture source.
- Unit tests cover validation, versioning, byte-preserving append, exact body
  updates, metadata parsing, wikilink resolution, recovery behavior, and safe
  error mapping.
- Security tests cover `..`, absolute/UNC/drive paths, mixed separators,
  case variants of excluded directories, symlinks, Windows junctions/reparse
  points where supported, hard links, and parent replacement races.
- Integration tests cover empty vaults, large notes, pagination, concurrent
  writes, crash recovery at each journal phase, backup retention, and conflict
  responses.
- Contract tests use MCP Inspector-compatible requests to verify schemas,
  annotations, structured results, invalid inputs, and unsupported tools.

No environment variable may silently override the test vault guard.

## 10. Proposed final repository structure

The repository follows this domain-oriented direction; some proposed modules
remain consolidated in the current implementation:

```text
obsidian-chatgpt/
├── AGENTS.md
├── README.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── .gitignore
├── .env.example
├── docs/
│   ├── architecture.md
│   ├── threat-model.md
│   └── tool-contracts.md
├── src/
│   ├── cli.ts
│   ├── config/
│   │   ├── load-config.ts
│   │   └── config-schema.ts
│   ├── mcp/
│   │   ├── create-server.ts
│   │   ├── server-instructions.ts
│   │   ├── transport/
│   │   │   └── streamable-http.ts
│   │   └── tools/
│   │       ├── list-notes.ts
│   │       ├── search-notes.ts
│   │       ├── read-note.ts
│   │       ├── create-note.ts
│   │       ├── append-to-note.ts
│   │       └── update-note.ts
│   ├── vault/
│   │   ├── vault-service.ts
│   │   ├── path-policy.ts
│   │   ├── note-enumerator.ts
│   │   ├── note-search.ts
│   │   ├── note-reader.ts
│   │   ├── note-writer.ts
│   │   ├── exact-note-edits.ts
│   │   ├── obsidian-metadata.ts
│   │   ├── wikilink-resolver.ts
│   │   ├── note-version.ts
│   │   └── recovery-store.ts
│   ├── errors/
│   │   ├── error-codes.ts
│   │   └── safe-error.ts
│   └── observability/
│       └── logger.ts
├── plugin/
│   ├── .codex-plugin/
│   │   └── plugin.json
│   ├── .app.json
│   ├── skills/
│   │   └── obsidian-vault-notes/
│   │       ├── SKILL.md
│   │       └── agents/
│   │           └── openai.yaml
│   └── assets/
└── tests/
    ├── fixtures/
    │   └── synthetic-vault/
    ├── unit/
    │   ├── path-policy.test.ts
    │   ├── exact-note-edits.test.ts
    │   └── note-version.test.ts
    ├── integration/
    │   ├── read-tools.test.ts
    │   ├── write-tools.test.ts
    │   └── recovery.test.ts
    └── security/
        ├── traversal.test.ts
        ├── links.test.ts
        └── concurrency.test.ts
```

Implementation modules are grouped by domain. The plugin package remains
separate from server source, and the test fixtures are unmistakably synthetic.

## 11. Evolution after the MVP

- Metadata parsing may add narrowly scoped Obsidian syntax only after fixtures
  define the expected behavior; it must retain raw note bytes as the source of
  truth and must not become a Markdown/YAML rewriting layer.
- If measurements justify a persistent lexical index, store it in the reserved
  internal area, validate it against note versions, and treat it as disposable.
- Public or multi-user distribution requires redesigning identity, OAuth,
  user-to-vault routing, hosting, and the local bridge. It is not a deployment
  toggle for this server.

## 12. Assumptions

- "Only access files inside one configured vault" refers to note, recovery,
  and index data. The Node.js runtime necessarily reads its own application
  files and trusted local configuration outside the vault.
- The user running the server already has OS-level access to the vault. A
  malicious process with the same OS identity is outside the security boundary
  because it can bypass MCP and edit the vault directly.
- Vault notes are valid UTF-8 and are small enough for the configured
  `maxNoteBytes`. Invalid or oversized files fail closed without mutation.
- The initial ChatGPT connection is private developer mode through Secure MCP
  Tunnel. Public directory submission is not an MVP goal.
- Manual local recovery from retained backups is acceptable for the MVP;
  exposing a restore tool would require a separate contract and safety review.
