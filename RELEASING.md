# Publishing Forge

Publish from `server/`; the repository root is intentionally private. The
published package includes the matching built plugin and preserves the MIT
license. Server and plugin package versions must match.

## Local release

1. Update `server/package.json`, `plugin/package.json`, versioned README examples,
   and regenerate their Bun lockfiles. Commit the reviewed changes.
2. Install development dependencies in root, server and plugin. Run
   `bun run check` and `(cd server && npm test)`.
3. Run `(cd server && npm pack)`. The prepack script builds from source and copies
   the plugin and documentation. Inspect `tar -tzf server/figma-mcp-forge-VERSION.tgz`;
   no credentials, fixtures, test files or unrelated artifacts belong in it.
4. Run `node scripts/smoke-package.mjs server/figma-mcp-forge-VERSION.tgz`.
   This installs the actual tarball without lifecycle scripts and checks the
   plugin assets and MCP handshake on an isolated port.
5. Authenticate with `npm login --registry=https://registry.npmjs.org` and check
   `npm whoami`. Complete npm's account/2FA requirements in your own browser.
6. Publish the tested tarball:
   `npm publish ./server/figma-mcp-forge-VERSION.tgz --access public`.
7. Verify `npm view figma-mcp-forge@VERSION version dist.integrity`, compare the
   integrity to the tested package, and test the registry install. Update the
   installed server and restart MCP clients and the matching Figma plugin.

The initial release requires an authenticated npm account. For subsequent CI
releases, configure an npm trusted publisher for `HieuAnh87/figma-mcp-forge`,
workflow `release.yml`, before running that workflow. No npm token is stored in
this repository. The workflow publishes the version already committed; it does
not modify or push source files. An npm version cannot be overwritten.
