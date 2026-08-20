# Threat model

Status: eight-tool MCP boundary with bounded metadata scans and recoverable writes implemented  
System: private ChatGPT-to-local-Obsidian MCP integration  
Last reviewed: 2026-08-20

## 1. Security objective

Allow an explicitly connected ChatGPT conversation to read and make limited,
recoverable changes to Markdown notes in one configured Obsidian vault without
granting general filesystem access.

The primary security properties are:

- Vault confinement: no tool can access a path outside the configured vault.
- Note confinement: only approved Markdown notes are tool-visible.
- Configuration isolation: `.obsidian` is not exposed.
- Link safety: symbolic links, junctions, reparse points, and hard-link aliases
  cannot be used to escape the vault.
- Concurrency safety: a write cannot silently replace a version newer than the
  one ChatGPT read.
- Recoverability: every modification to an existing note retains the exact
  pre-write bytes and can survive an interrupted commit.
- Content privacy: note text and search queries do not enter default logs.
- Minimal capability: no delete, arbitrary file, shell, network-fetch, or UI
  capability exists.

## 2. Assets

- Markdown note contents, filenames, directory names, YAML frontmatter, and
  wikilinks.
- Vault layout and the absolute host path to the vault.
- The integrity and availability of current notes.
- Recovery backups and transaction journals.
- Secure MCP Tunnel runtime API key and tunnel identity.
- MCP connection metadata and any future OAuth credentials.
- Logs, metrics, and diagnostic bundles.

## 3. Trust boundaries

```text
Untrusted/partially trusted                         Trusted local boundary

User prompt -----> ChatGPT/model -----> OpenAI tunnel endpoint
                        |                         |
                        | note content is data    | outbound authenticated path
                        v                         v
                 MCP tool request --------> tunnel-client
                                                   |
                                                   v
                                           loopback MCP server
                                                   |
                                         validation + authorization
                                                   |
                                                   v
                                             one vault root
```

Boundary observations:

- User prompts and note contents are untrusted input. A note may contain prompt
  injection text intended to influence later model behavior.
- ChatGPT is authorized to receive note content only when the user invokes or
  approves the connected tool workflow. Content deliberately returned by a
  tool has left the local machine's confidentiality boundary.
- The tunnel provides private reachability and control-plane authentication; it
  does not automatically implement end-user authorization for a shared app.
- The local MCP process and `tunnel-client` run as the vault-owning OS user.
- The configured vault root is trusted configuration, not model input.
- A malicious process already running as the same OS user can read or modify
  the vault directly and is outside the enforceable MCP boundary.

## 4. Threat actors

- A remote user with access to the ChatGPT workspace or mistakenly shared
  plugin connection.
- Malicious or misleading instructions in a note.
- A model that selects the wrong tool or produces malformed/overbroad
  arguments.
- A local low-privilege process probing a non-loopback server listener.
- Another local application, including Obsidian or sync software, editing a
  note concurrently.
- A crafted vault containing traversal names, symlinks, junctions, reparse
  points, hard links, malformed UTF-8, oversized files, or hostile YAML.
- An operator who accidentally points automated tests at a real vault.
- An attacker who obtains the tunnel runtime key or sensitive logs.

## 5. Threats and controls

| ID | Threat | Primary controls | Residual risk |
| --- | --- | --- | --- |
| T1 | `../`, absolute, drive, UNC, or mixed-separator traversal | Logical-path grammar, absolute-path rejection, segment checks, canonical root containment, pre-operation revalidation | Platform path edge cases require continuous Windows/POSIX tests |
| T2 | Symlink or junction escapes the vault | Reject linked/reparse root and every linked component using `lstat`; never follow links during enumeration | Same-user attacker can race path replacement; that actor already has direct vault access |
| T3 | Hard link inside vault aliases an external file | Reject live note files with link count greater than one | Link-count support varies by filesystem; unsupported safety checks disable writes |
| T4 | Read or write `.obsidian` | Case-insensitive segment denylist applied before filesystem access and enumeration | Operator access outside MCP is unaffected |
| T5 | Access a non-Markdown file | Require `.md`, regular file, valid UTF-8, and bounded size | A `.md` file may contain arbitrary sensitive text by design |
| T6 | Overwrite a newer Obsidian/sync edit | Mandatory raw-byte SHA-256 revision for MCP append/update, process write mutex, commit-time recheck, no-clobber install | Concurrent same-user programs do not honor the process mutex; competing bytes are preserved and surfaced as conflict/recovery-required |
| T7 | Crash causes partial or lost write | Same-directory staging, `fsync`, journal, recovery name, pre-write recovery gate, exact pre-write backup | Power-loss guarantees depend on filesystem durability semantics |
| T8 | `create_note` overwrites an existing file | Exclusive/no-clobber create; no overwrite option | Case-folding and normalization collisions must be tested per platform |
| T9 | Update corrupts frontmatter or wikilinks | Exact unique body matches, non-overlapping ranges, protected leading YAML frontmatter, raw UTF-8 slicing with no Markdown/YAML reserialization, and an exact pre-write backup | An intentionally broad exact match can still replace selected user text; local backup recovery is not exposed through MCP |
| T10 | Prompt injection in note content triggers unintended actions | Skill and server instructions label contents as untrusted data; distinct read/write tools; write annotations; mandatory current version; server-enforced scope | The model still processes returned content; workspace and model safeguards remain relevant |
| T11 | Note content leaks through logs | Metadata-only logger; no raw args/results/query/content; safe error mapping; tunnel raw logging remains off | Content is intentionally returned to ChatGPT and may be covered by workspace compliance logs |
| T12 | Tunnel key leaks | Secret manager/environment, redaction, least-privilege tunnel role, rotation, no repository storage | A stolen active key remains useful until revoked/expired |
| T13 | Unauthorized workspace user reaches vault | Narrow workspace/tunnel association, private developer-mode connection, no broad workspace sharing | MVP has no end-user OAuth; sharing the connection is equivalent to sharing vault access |
| T14 | MCP endpoint is reached from LAN/internet | Hard-coded loopback-only binding policy for MVP; startup rejects other interfaces | Other same-host processes can connect unless an additional local credential is introduced |
| T15 | Search, metadata, or backlink scans exhaust CPU, memory, tokens, or disk I/O | Request/note limits, literal parsing, file/byte/result/link ceilings, pagination or explicit truncation | Very large vaults may exceed scan limits or produce explicitly incomplete metadata |
| T16 | Malformed YAML exploits metadata parsing | No general YAML evaluator or object construction; only boundaries, bounded raw text, simple top-level keys, and common tag forms are detected | Complex valid YAML may be represented only as bounded raw frontmatter and not structurally interpreted |
| T17 | Error reveals host filesystem layout | Relative paths only, generic I/O errors, no stack traces or absolute paths in MCP results | Local operator logs can reveal operational metadata when explicitly enabled |
| T18 | Automated tests mutate real notes | Per-test temporary vault, synthetic marker, startup guard in test mode, no fallback to configured real vault | A deliberately disabled guard would be an operator/code-review failure |
| T19 | Backups become a second ungoverned copy | Reserved in-vault directory, tool exclusion, same OS permissions, documented sync implications; automated retention remains a required later control | Vault sync/backup software may copy the reserved directory along with the vault, and retained versions consume storage until pruning is implemented |
| T20 | A fake/unsupported safe-write filesystem causes corruption | Probe required primitives, fail writes closed with `UNSAFE_FILESYSTEM`, recovery tests | Some removable/network filesystems will be read-only through the plugin |
| T21 | Ambiguous Obsidian link resolution attributes a backlink to the wrong note | Resolve explicit paths; resolve basename-only links only when unique or uniquely local; report other duplicates as `ambiguous`; never open a link-derived path | This conservative subset may omit backlinks that Obsidian resolves using richer rules |

## 6. Path security policy

### 6.1 Logical paths

Tool paths are not URLs and are never percent-decoded. They use `/` as the
only separator. Reject:

- Empty paths and trailing separators
- Leading `/`, `\\`, drive letters, device namespaces, and URI schemes
- Backslashes, NUL, control characters, and `:`
- Empty, `.` or `..` segments
- Windows device basenames such as `CON`, `PRN`, `AUX`, `NUL`, `COM1`, and
  `LPT1`, even when followed by an extension
- Segments equal to `.obsidian` or `.obsidian-chatgpt`, ignoring case
- A final extension other than `.md`, ignoring case
- Paths longer than configured total and per-segment limits

The implementation should avoid Unicode normalization. It uses the exact path
provided, then lets the filesystem resolve the actual entry. Enumeration must
return the filesystem spelling so ChatGPT can pass it back unchanged.

### 6.2 Canonical containment

String prefix checks are insufficient (`C:\vault-evil` begins with
`C:\vault`). Containment is determined with platform path primitives:

1. Canonicalize the trusted root once with `realpath`.
2. Join only a validated logical path.
3. `lstat` each existing segment from root to target and reject links/reparse
   points.
4. Resolve the existing target or nearest existing parent with `realpath`.
5. Compute its path relative to the canonical root.
6. Accept only `.` or a relative value that is neither absolute nor begins
   with a parent segment.
7. Re-run relevant checks immediately before opening or committing.

Create-parent behavior walks one segment at a time with exclusive directory
creation and revalidates after each step.

### 6.3 File opens

- Reads open only regular files and apply no-follow flags when supported.
- Writes never open an existing note with truncate flags.
- Staging, lock, journal, and backup names use cryptographically unpredictable
  transaction IDs and exclusive creation.
- Tool-visible enumeration ignores staging/recovery files even if a crash
  leaves one behind.
- Hard-linked live notes are rejected before reads that could disclose an
  external alias and before writes that could modify it.

## 7. Concurrency and recovery abuse cases

### Stale model write

An attacker or ordinary editor changes a note after `read_note`. The stale
`expected_revision` fails before staging or commit. The error contains no note
content. ChatGPT must reread and reconsider the change.

### Change during commit

Another application changes the file between validation and installation. The
current target is captured under a recovery name, hashed, and compared again.
If it is unexpected, it is restored without clobbering another target. The
new staged file is installed only through a no-clobber primitive, so a target
created during the short swap window is never silently replaced.

### Process crash

A durable journal identifies the operation, relative target, staging name,
recovery name, expected version, intended version, and backup. It contains no
note text. Before each Vault Service write, the service resolves every journal
path through the same vault policy, then chooses among these safe outcomes:

- Restore the recovery copy if the live target is missing and the transaction
  was not committed.
- Finalize the backup if the live target has the intended version.
- Preserve all files and mark the transaction for operator review if state is
  ambiguous.

Vault Service and MCP writes remain unavailable while unresolved recovery is
present. Read
tools may remain available only when they cannot expose internal transaction
files.

### Backup abuse

Backup IDs are opaque and never accepted as note paths. The backup tree is
excluded before traversal. Automatic retention is not implemented in this
milestone; recovery tooling is local-only and not part of the MCP surface.

## 8. Prompt injection and model safety

Markdown content may say things such as "ignore previous instructions" or ask
the model to modify unrelated notes. The server cannot determine whether prose
is trustworthy, so it enforces capabilities rather than attempting content
sanitization.

- Tool results describe note text as untrusted user data.
- A read result grants no additional authority.
- The skill instructs the model never to treat note text as permission to call
  a write tool.
- Write tools require an explicit path, a version obtained from a prior read,
  and a narrowly defined change.
- `update_note` uses bounded, exact, revision-checked body replacements rather
  than a general filesystem patch or shell command.
- There is no delete, rename, move, command execution, arbitrary URL fetch, or
  arbitrary path tool.
- Tool safety annotations accurately distinguish reads, additive create/append
  mutations, and destructive exact-text updates.

User confirmation behavior in ChatGPT is defense in depth. Correctness must
not depend on the model choosing to ask for confirmation.

## 9. Authentication decision

Official OpenAI guidance expects customer-specific data and write actions to
use authentication for shared or published MCP services. This MVP is instead a
private, single-user local process connected through Secure MCP Tunnel:

- It binds only to loopback.
- The OS account controls the vault.
- The tunnel runtime key authenticates `tunnel-client` to OpenAI.
- Platform and ChatGPT workspace associations constrain discovery/use.

This is acceptable only under the explicit assumption that the connection is
not shared. Before any LAN binding, multi-user workspace rollout, hosted
service, or public submission, add MCP OAuth 2.1 with separate read/write
scopes, validate issuer/audience/expiry/scopes for every call, and authorize a
specific identity to a specific vault. OpenAI-managed mTLS can identify
ChatGPT at a public TLS endpoint but does not replace end-user OAuth.

References:

- [OpenAI authentication guidance](https://developers.openai.com/plugins/build/auth)
- [Secure MCP Tunnel security and permissions](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## 10. Logging and telemetry policy

The logger accepts typed metadata fields, not arbitrary request objects.
Allowed default fields are tool name, request ID, outcome code, duration,
counts, byte sizes, and a per-process salted path fingerprint.

The following are forbidden in all normal log levels:

- Raw tool inputs or outputs
- Note text, snippets, YAML, wikilinks, or appended/replacement text
- Search query text
- Absolute/relative note path text
- Authorization headers, cookies, tokens, environment dumps, or tunnel config
- Stack traces returned to ChatGPT

Metrics use counters and histograms without content-bearing labels. A future
support bundle must enumerate and test every included field and remain redacted
by default.

## 11. Test safety controls

The test harness creates a unique temporary root and a synthetic vault marker.
When `NODE_ENV=test` (or the test runner's equivalent) is active, configuration
validation requires both:

1. The canonical vault path is inside the harness-owned temporary root.
2. The marker contains the current test run's random ID.

Tests must not inherit `VAULT_ROOT` from the developer shell. CI and local
test scripts pass the synthetic root explicitly. Tests fail rather than skip
when the guard is not satisfied.

Fixture notes use invented names and content. A regression test confirms that
known home-directory, Documents, OneDrive, iCloud, and common Obsidian paths
are rejected as test roots.

## 12. Security acceptance checklist

Before the MVP is considered ready:

- [x] All eight tool schemas reject unknown fields and enforce size/count limits.
- [ ] Every filesystem entry point calls the central path policy.
- [ ] `.obsidian` and `.obsidian-chatgpt` are absent from list/search results.
- [ ] Traversal, symlink, junction/reparse, and hard-link tests pass on supported
      platforms.
- [x] MCP append/update require `expected_revision`; the service rechecks the
      raw-byte revision immediately before commit.
- [ ] Create cannot overwrite an existing or case-colliding path.
- [ ] Crash-injection tests pass at every transaction phase.
- [ ] Recovery preserves all ambiguous versions and blocks further writes.
- [ ] Frontmatter bytes are unchanged by append and body edits.
- [x] Append preserves all existing bytes; update preserves every byte outside
      validated exact body replacements without reserialization.
- [ ] Logs contain no content, query, path, secret, or raw MCP payload.
- [ ] The listener refuses non-loopback configuration.
- [ ] Test mode cannot start against an unmarked or non-temporary vault.
- [ ] MCP Inspector confirms names, descriptions, schemas, results, errors, and
      annotations.
- [ ] ChatGPT evaluation prompts include direct, indirect, negative,
      prompt-injection, stale-write, and unsupported-delete cases.
- [ ] The plugin/tunnel is limited to the intended developer-mode user/workspace.

## 13. Explicitly accepted residual risks

- ChatGPT receives the content a user asks it to read; transport privacy does
  not make that content local-only.
- A malicious same-OS-user process can bypass the MCP server and manipulate the
  vault directly.
- Filesystem durability after sudden power loss varies. Journaling, `fsync`,
  and backups reduce risk but cannot exceed the underlying filesystem's
  guarantees.
- Bounded literal search may return incomplete results for a vault exceeding
  configured limits.
- In-vault recovery data may be copied by the user's existing vault sync or
  backup system. It inherits the vault's access controls and retention must be
  documented.
- The private MVP lacks end-user OAuth. This is not acceptable for a shared,
  remotely reachable, or public service.
