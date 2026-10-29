import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = join(root, "server");
const plugin = join(root, "plugin");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const version = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
if (version(server) !== version(plugin)) throw new Error("Server/plugin versions must match");
// Rebuild from source so old dist files cannot enter a release tarball.
rmSync(join(server, "dist"), { recursive: true, force: true });
for (const [cwd, command] of [
  [server, "build"],
  [plugin, "typecheck"],
  [plugin, "build"],
]) {
  execFileSync(npm, ["run", command], { cwd, stdio: "inherit" });
}
rmSync(join(server, "plugin"), { recursive: true, force: true });
for (const name of ["manifest.json", "dist/code.js", "dist/index.html"]) {
  const target = join(server, "plugin", name);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(plugin, name), target);
}
for (const name of ["README.md", "FORGE.md", "RELEASING.md", "LICENSE.md"]) {
  copyFileSync(join(root, name), join(server, name));
}

const assets = ["manifest.json", "dist/code.js", "dist/index.html"];
writeFileSync(
  join(server, "plugin/forge-release.json"),
  JSON.stringify(
    {
      package: "figma-mcp-forge",
      version: version(server),
      files: Object.fromEntries(
        assets.map((name) => [
          name,
          createHash("sha256")
            .update(readFileSync(join(server, "plugin", name)))
            .digest("hex"),
        ])
      ),
    },
    null,
    2
  ) + "\n"
);
