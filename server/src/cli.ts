import { copyFile, mkdir, readFile, rename, rm, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { VERSION } from "./version.js";
import { probeLeader } from "./health.js";
import { Follower } from "./follower.js";

const assets = ["manifest.json", "dist/code.js", "dist/index.html"];
export const pluginDirectory = () =>
  join(
    process.env.FIGMA_FORGE_HOME ?? join(homedir(), ".local", "share", "figma-mcp-forge"),
    "plugin"
  );
const bundled = fileURLToPath(new URL("../plugin/", import.meta.url));
type Receipt = { package: string; version: string; files: Record<string, string> };

export async function verifyPlugin(dir: string): Promise<Receipt> {
  const receipt: Receipt = JSON.parse(await readFile(join(dir, "forge-release.json"), "utf8"));
  if (receipt.package !== "figma-mcp-forge" || typeof receipt.version !== "string")
    throw new Error("Invalid Forge plugin receipt");
  for (const name of assets) {
    const actual = createHash("sha256")
      .update(await readFile(join(dir, name)))
      .digest("hex");
    if (actual !== receipt.files[name])
      throw new Error(`Plugin asset differs from release: ${name}`);
  }
  return receipt;
}

export async function installPlugin(target = pluginDirectory(), source = bundled): Promise<string> {
  const receipt = await verifyPlugin(source);
  if (receipt.version !== VERSION) throw new Error("Bundled plugin/server versions differ");
  const destination = resolve(target);
  let exists = false;
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Refusing to replace a non-directory or symlink plugin path");
    // Only replace an unmodified installation made by this command.
    await verifyPlugin(destination);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // A directory without its receipt is not ours to overwrite.
    try {
      await lstat(destination);
      throw new Error(
        "Existing plugin directory has no valid Forge receipt; preserve it and choose another FIGMA_FORGE_HOME"
      );
    } catch (check) {
      if ((check as NodeJS.ErrnoException).code !== "ENOENT") throw check;
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  const stage = `${destination}.stage-${randomUUID()}`;
  const backup = `${destination}.backup-${randomUUID()}`;
  let moved = false;
  try {
    for (const name of [...assets, "forge-release.json"]) {
      await mkdir(dirname(join(stage, name)), { recursive: true });
      await copyFile(join(source, name), join(stage, name));
    }
    await verifyPlugin(stage);
    if (exists) {
      await rename(destination, backup);
      moved = true;
    }
    try {
      await rename(stage, destination);
    } catch (error) {
      if (moved) await rename(backup, destination);
      throw error;
    }
    if (moved) await rm(backup, { recursive: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return join(destination, "manifest.json");
}

export async function runCli(args: string[], port: number): Promise<boolean> {
  if (!args.length) return false;
  if (args.length === 1 && args[0] === "--version") {
    console.log(VERSION);
    return true;
  }
  if (args.length === 1 && ["--help", "help"].includes(args[0])) {
    console.log(`Figma MCP Forge ${VERSION}
Usage: figma-mcp-forge                    Start MCP over stdio
       figma-mcp-forge plugin install     Install matching plugin at a stable path
       figma-mcp-forge plugin path        Print manifest path (does not install)
       figma-mcp-forge doctor [--json]    Check local install and running bridge
       figma-mcp-forge --version
Set FIGMA_FORGE_HOME to override ~/.local/share/figma-mcp-forge.
After installing: Figma Desktop > Plugins > Development > Import plugin from manifest.
Keep the plugin open. Restart all MCP clients and reopen the plugin after upgrades.`);
    return true;
  }
  if (args.length === 2 && args[0] === "plugin" && args[1] === "path") {
    console.log(join(pluginDirectory(), "manifest.json"));
    return true;
  }
  if (args.length === 2 && args[0] === "plugin" && args[1] === "install") {
    console.log(await installPlugin());
    console.log(
      "Import this manifest in Figma Desktop, then run Figma MCP Forge. Reopen the plugin after upgrades."
    );
    return true;
  }
  if (args[0] === "doctor" && (args.length === 1 || (args.length === 2 && args[1] === "--json"))) {
    const issues: string[] = [];
    let installedVersion: string | null = null;
    let leader: Awaited<ReturnType<typeof probeLeader>> = null;
    let files: Awaited<ReturnType<Follower["listConnectedFiles"]>> = [];
    try {
      installedVersion = (await verifyPlugin(pluginDirectory())).version;
      if (installedVersion !== VERSION)
        issues.push(
          "Installed plugin differs from CLI; run plugin install and reopen Figma plugin"
        );
    } catch (err) {
      issues.push(`Plugin install: ${(err as Error).message}. Run plugin install.`);
    }
    const url = `http://localhost:${port}`;
    try {
      leader = await probeLeader(url);
      if (!leader) issues.push("No Forge server running; start the MCP client");
      else {
        files = await new Follower(url).listConnectedFiles();
        if (!files.length) issues.push("No file connected; open the Forge plugin in Figma");
        for (const file of files)
          if (!file.compatible)
            issues.push(
              `Reopen matching plugin for ${file.fileName} (${file.pluginVersion ?? "unknown version"})`
            );
      }
    } catch (err) {
      issues.push((err as Error).message);
    }
    const report = {
      ok: issues.length === 0,
      cliVersion: VERSION,
      installedVersion,
      manifestPath: join(pluginDirectory(), "manifest.json"),
      port,
      leader,
      files,
      issues,
    };
    console.log(JSON.stringify(report, null, 2));
    if (issues.length) process.exitCode = 1;
    return true;
  }
  throw new Error("Unknown command. Run figma-mcp-forge --help");
}
