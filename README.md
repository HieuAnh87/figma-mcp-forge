# Figma MCP Forge

Read, edit, and audit live Figma and FigJam documents from Codex, Claude Code,
OpenCode, or another MCP client. Forge supports native components, variables,
styles, prototypes, bounded audits, and revision-checked build checkpoints.

Forge is an MIT-licensed fork of
[gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge).
The npm package includes **both the MCP server and the matching built Figma plugin**.

## Install

Requirements: Node.js 20+ and the Figma desktop app for importing the development plugin.
Bun is not needed to run the published package.

```sh
npm install --global figma-mcp-forge@0.1.0
npm root --global
```

Under the directory printed by the second command, find
`figma-mcp-forge/plugin/manifest.json`.
In Figma, choose **Plugins → Development → Import plugin from manifest** and
select that file. Run **Figma MCP Forge** in each file you want to connect, and
keep the plugin open.

Configure your MCP client with the command `figma-mcp-forge`. The standard
server definition is:

```json
{
  "mcpServers": {
    "figma-forge": {
      "command": "figma-mcp-forge",
      "args": [],
      "env": { "FIGMA_BRIDGE_ENABLE_RUN_SCRIPT": "1" }
    }
  }
}
```

`run_script` executes arbitrary Plugin API JavaScript in the open file. Omit the
environment setting if you only need the typed tools. Configure allowed local
asset directories separately; see [FORGE.md](FORGE.md#configuration).

### Claude Code

```sh
claude mcp add -s user figma-forge -e FIGMA_BRIDGE_ENABLE_RUN_SCRIPT=1 -- figma-mcp-forge
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.figma-forge]
command = "figma-mcp-forge"

[mcp_servers.figma-forge.env]
FIGMA_BRIDGE_ENABLE_RUN_SCRIPT = "1"
```

### OpenCode

In the MCP section of your OpenCode configuration, use a local server with
`command: ["figma-mcp-forge"]` and the same environment setting. Use the layout
required by your installed OpenCode version.

Restart the client, then call `list_files`. Always pass an explicit `fileKey`
when multiple files are connected. A desktop app that does not inherit your
shell PATH may need the absolute executable path from `command -v figma-mcp-forge`.

An alternative server command is `npx -y figma-mcp-forge@0.1.0`; the plugin must
still be installed separately from the same version. Prefer the global install
above for a stable plugin location. Disable other Figma bridges in the client
configuration when using Forge alone. Do not configure the upstream package
`@gethopp/figma-mcp-bridge`: it uses a different bridge port.

## Working safely

1. Discover files, inspect the intended nodes and run `design_preflight`.
2. Read the build checkpoint before continuing an existing design.
3. Work in small batches with one writer per owned subtree.
4. Run `audit_design`, export fresh screenshots, and inspect visual results.
5. Commit the validated checkpoint. Checkpoints record progress; they are not rollback.

The server stops waiting after three minutes; that does **not** cancel a running
plugin script. Inspect live nodes before retrying. Reopening the plugin can
change fallback file keys, so rediscover files before resuming.

Structural audits are bounded and do not prove visual correctness. Inspect
`complete`, `timedOut`, and `issuesTruncated`. The plugin must remain open; this
is not a headless Figma service. Dev Mode is read-only. Some tools are specific
to Figma or FigJam, and native Figma plan limits still apply.

## Configuration and upgrades

Forge listens on loopback port **1995** by default. Multiple client processes
share the local leader connection. See [FORGE.md](FORGE.md) for configuration,
authoring tools, font handling, and recovery guidance.

Upgrade the npm package, close and reopen the Figma plugin, and restart MCP
clients together so their server and plugin versions match.

## Development and release

```sh
bun install --frozen-lockfile
(cd server && bun install --frozen-lockfile)
(cd plugin && bun install --frozen-lockfile)
bun run check
(cd server && npm test)
(cd server && npm pack)
```

`npm pack` rebuilds both parts, checks plugin types and copies only the intended
plugin assets and documentation into the server package. Inspect the tarball
before publishing. See [RELEASING.md](RELEASING.md) for release checks.

## License

MIT. The upstream GETHOPP LTD copyright is preserved in [LICENSE.md](LICENSE.md).
