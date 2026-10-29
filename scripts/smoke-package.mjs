import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const tarball = process.argv[2];
if (!tarball) throw new Error("Usage: node scripts/smoke-package.mjs <tarball>");
const dir = mkdtempSync(join(tmpdir(), "forge-package-"));
try {
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", resolve(tarball)],
    { stdio: "inherit" }
  );
  const pkg = join(dir, "node_modules/figma-mcp-forge");
  const entry = join(pkg, "dist/index.js");
  const env = { ...process.env, FIGMA_FORGE_HOME: join(dir, "stable-forge") };
  const cli = (...args) =>
    execFileSync(process.execPath, [entry, ...args], { env, encoding: "utf8" });
  const expectedVersion = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
  assert.equal(cli("--version").trim(), expectedVersion);
  cli("plugin", "install");
  assert.ok(existsSync(cli("plugin", "path").trim()));
  cli("plugin", "install"); // repeat upgrade must preserve a working install
  const manifest = JSON.parse(readFileSync(join(pkg, "plugin/manifest.json"), "utf8"));
  for (const name of [manifest.main, manifest.ui])
    assert.ok(existsSync(join(pkg, "plugin", name)), `Missing ${name}`);
  for (const name of ["README.md", "FORGE.md", "LICENSE.md"])
    assert.ok(existsSync(join(pkg, name)));
  const sdk = join(dir, "node_modules/@modelcontextprotocol/sdk/dist/esm/client");
  const { Client } = await import(pathToFileURL(join(sdk, "index.js")));
  const { StdioClientTransport } = await import(pathToFileURL(join(sdk, "stdio.js")));
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const client = new Client({ name: "forge-package-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(pkg, "dist/index.js")],
    env: {
      ...process.env,
      FIGMA_BRIDGE_PORT: String(port),
      FIGMA_BRIDGE_HOST: "127.0.0.1",
      FIGMA_BRIDGE_ENABLE_RUN_SCRIPT: "1",
    },
  });
  try {
    await client.connect(transport);
    const declared = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
    assert.equal(client.getServerVersion().version, declared.version);
    const { tools } = await client.listTools();
    for (const name of ["list_files", "run_script", "audit_design", "get_build_checkpoint"])
      assert.ok(
        tools.some((t) => t.name === name),
        `Missing tool ${name}`
      );
    const result = await client.callTool({ name: "list_files", arguments: {} });
    assert.ok(!result.isError);
    assert.deepEqual(JSON.parse(result.content.find((c) => c.type === "text").text), []);
    const { WebSocket } = createRequire(join(pkg, "package.json"))("ws");
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?fileKey=smoke&version=${expectedVersion}&protocol=1`
    );
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    try {
      const report = JSON.parse(
        execFileSync(process.execPath, [entry, "doctor", "--json"], {
          env: { ...env, FIGMA_BRIDGE_PORT: String(port) },
          encoding: "utf8",
        })
      );
      assert.equal(report.ok, true);
      assert.equal(report.files[0].compatible, true);
    } finally {
      ws.terminate();
    }
    console.log(
      `Package smoke passed: ${declared.name}@${declared.version}, ${tools.length} tools and matching plugin assets`
    );
  } finally {
    await client.close();
    await transport.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
