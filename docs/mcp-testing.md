# MCP local testing

This guide validates the MCP server locally before connecting it to ChatGPT or
a Secure MCP Tunnel. The server must advertise exactly these tools:

- `list_notes`
- `search_notes`
- `read_note`
- `get_note_metadata`
- `get_backlinks`
- `create_note`
- `append_to_note`
- `update_note`

No delete, restore, rename, or move tool is part of this milestone.

The workflow follows OpenAI's current recommendation to expose Streamable HTTP
at `/mcp`, connect MCP Inspector, and check initialization, instructions, tool
metadata, representative calls, invalid inputs, results, and errors. See
[Build an MCP server](https://developers.openai.com/plugins/build/mcp-server#run-and-test-locally).

## Prerequisites

- Node.js 24 or newer
- Dependencies installed with `npm install`
- Run commands from the repository root

On Windows, use `npm.cmd` or `npx.cmd` if PowerShell blocks the corresponding
`.ps1` shim.

## Automated smoke test

Run the complete seven-check smoke path with:

```bash
npm run mcp:smoke
```

The smoke runner does not load `OBSIDIAN_VAULT_PATH` and cannot select a real
vault. It copies the invented fixture notes into a fresh, marked operating-
system temporary directory, starts the actual Streamable HTTP server on an
ephemeral loopback port, connects with the official MCP SDK client, and removes
the temporary tree after the run.

It checks:

1. MCP initialization succeeds and returns the expected server identity.
2. `tools/list` contains exactly the eight tools above.
3. `list_notes` returns a known synthetic note.
4. `search_notes` returns a known synthetic match.
5. `read_note` returns a known synthetic note and revision.
6. A malformed call returns a controlled MCP tool error without success data.
7. A valid-looking Markdown path through a symlink or Windows junction to an
   outside file is rejected without reading or exposing that file.

The command prints one content-free `PASS` line per check and exits nonzero on
failure. For the broader MCP integration suite, run:

```bash
npm run mcp:test
```

Run all repository checks with:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Start the local server for MCP Inspector

Manual Inspector calls use the vault configured for the server process. Use a
disposable copy of the synthetic fixture rather than a personal Obsidian vault
while validating.

PowerShell:

```powershell
$validationVault = Join-Path ([IO.Path]::GetTempPath()) ("obsidian-chatgpt-inspector-" + [guid]::NewGuid().ToString("N"))
Copy-Item -LiteralPath .\tests\fixtures\synthetic-vault -Destination $validationVault -Recurse
$env:OBSIDIAN_VAULT_PATH = $validationVault
npm.cmd run mcp:start
```

macOS or Linux:

```bash
validation_vault="$(mktemp -d)"
cp -R tests/fixtures/synthetic-vault/. "$validation_vault"
OBSIDIAN_VAULT_PATH="$validation_vault" npm run mcp:start
```

`mcp:start` runs the TypeScript entry point without watch mode. It uses
`MCP_HOST`, `MCP_PORT`, `LOG_LEVEL`, and `BACKUP_DIR` from the process or
optional `.env`, with the documented defaults. The default endpoints are:

```text
MCP:       http://127.0.0.1:3000/mcp
Health:    http://127.0.0.1:3000/health
Readiness: http://127.0.0.1:3000/ready
```

The ready log contains endpoint metadata only; it does not print the vault
path, note paths, queries, or note contents.

An optional PowerShell readiness check is:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/ready
```

Expected response:

```json
{
  "status": "ready"
}
```

## Connect MCP Inspector

Keep the server running and open a second terminal. Start the current Inspector
package requested for local validation:

```bash
npx @modelcontextprotocol/inspector@latest
```

`npx` may ask permission to download the package and prints the local Inspector
address. In the Inspector UI:

1. Select **Streamable HTTP** as the transport.
2. Enter `http://127.0.0.1:3000/mcp`, adjusted if `MCP_HOST` or `MCP_PORT` was
   changed.
3. Connect. Inspector performs the MCP initialize exchange.
4. Confirm the server identity is `obsidian-chatgpt-mcp` and review the server
   instructions.
5. Open **Tools** and confirm the list contains exactly `list_notes`,
   `search_notes`, `read_note`, `get_note_metadata`, `get_backlinks`,
   `create_note`, `append_to_note`, and `update_note`.

Try these representative tool inputs:

`list_notes`:

```json
{
  "folder": "Projects",
  "recursive": false,
  "limit": 10
}
```

`search_notes`:

```json
{
  "query": "handshaking lemma",
  "folder": "Research",
  "scope": "content",
  "limit": 5
}
```

`read_note`:

```json
{
  "path": "Projects/Alpha Project.md"
}
```

`get_note_metadata`:

```json
{
  "path": "Projects/Alpha Project.md"
}
```

Confirm the result contains bounded frontmatter, tags, headings, and outgoing
wikilinks, including the `the roadmap` alias and resolved target path.

`get_backlinks`:

```json
{
  "path": "Projects/Alpha Project.md",
  "limit": 10
}
```

Confirm the source paths and source revisions are returned from a bounded
local scan and that no database or external system is involved.

Write calls below mutate only the disposable validation vault created in the
previous section. Do not point the manual server at a personal vault while
testing them.

`create_note`:

```json
{
  "path": "Inspector/New note.md",
  "content": "---\ntags: [inspector-test]\n---\n# New note\n"
}
```

Next call `read_note` for `Inspector/New note.md` and copy its `version` into
`expected_revision` for one of these calls.

`append_to_note`:

```json
{
  "path": "Inspector/New note.md",
  "content": "\nAdded through MCP Inspector.\n",
  "expected_revision": "sha256:copy-the-current-version-here"
}
```

Read the note again before testing `update_note`, because append changes the
version. Update applies exact replacements to unique Markdown body matches.

`update_note`:

```json
{
  "path": "Inspector/New note.md",
  "edits": [
    {
      "old_text": "Added through MCP Inspector.",
      "new_text": "Updated through MCP Inspector."
    }
  ],
  "expected_revision": "sha256:copy-the-new-current-version-here"
}
```

For each call, inspect both the concise text result and `structuredContent`.
Confirm tool schemas reject unknown fields. The five read tools must be read-only;
create and append must be additive/non-destructive; update must be destructive
because it can replace selected existing text. Every tool is idempotent at the
side-effect level and closed-world.

Also try invalid calls:

- Call `read_note` without `path`; expect a controlled input-validation error.
- Call `read_note` with `../Outside.md`; expect rejection before filesystem
  access.
- Call `read_note` with `.obsidian/Workspace.md`; expect `PATH_FORBIDDEN`.
- Call `get_note_metadata` without `path`; expect input rejection.
- Call `get_backlinks` with `limit: 101`; expect input rejection.
- Call `append_to_note` without `expected_revision`; expect input rejection.
- Call `update_note` with a stale revision; expect `VERSION_CONFLICT` and no
  change to the note.
- Call `create_note` for an existing path; expect `ALREADY_EXISTS`.

Errors must not contain an absolute vault path, host username, stack trace, or
note content. Stop both processes with Ctrl+C when inspection is complete and
remove the disposable manual vault when it is no longer needed.

## Troubleshooting

- If startup reports invalid configuration, verify `OBSIDIAN_VAULT_PATH` is an
  absolute path to an existing, non-linked directory and the host is loopback.
- If Inspector cannot connect, check `/ready`, confirm the port in the server's
  ready log, and use the matching URL in Inspector.
- Do not use `GET /mcp` as a health check; it requires an initialized MCP
  session. Use `/health` or `/ready`.
- The local endpoint intentionally rejects non-loopback binding. Do not expose
  it directly on a LAN or the public internet.
