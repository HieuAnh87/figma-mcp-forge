import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { installPlugin, verifyPlugin } from "./cli.js";
import { VERSION } from "./version.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-install-test-"));
  const source = join(root, "source");
  await mkdir(join(source, "dist"), { recursive: true });
  const files = {
    "manifest.json": '{"name":"Forge"}',
    "dist/code.js": "code",
    "dist/index.html": "html",
  };
  for (const [name, data] of Object.entries(files)) await writeFile(join(source, name), data);
  await writeFile(
    join(source, "forge-release.json"),
    JSON.stringify({
      package: "figma-mcp-forge",
      version: VERSION,
      files: Object.fromEntries(
        Object.entries(files).map(([name, data]) => [
          name,
          createHash("sha256").update(data).digest("hex"),
        ])
      ),
    })
  );
  return {
    root,
    source,
    target: join(root, "installed"),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("plugin install produces stable manifest and can safely repeat", async () => {
  const f = await fixture();
  try {
    assert.equal(await installPlugin(f.target, f.source), join(f.target, "manifest.json"));
    assert.equal((await verifyPlugin(f.target)).version, VERSION);
    await installPlugin(f.target, f.source);
    assert.equal(await readFile(join(f.target, "dist/code.js"), "utf8"), "code");
  } finally {
    await f.close();
  }
});
test("installer preserves user-modified assets and rejects corrupt bundles", async () => {
  const f = await fixture();
  try {
    await installPlugin(f.target, f.source);
    await writeFile(join(f.target, "dist/code.js"), "user edit");
    await assert.rejects(installPlugin(f.target, f.source), /differs/);
    assert.equal(await readFile(join(f.target, "dist/code.js"), "utf8"), "user edit");
    await writeFile(join(f.source, "dist/index.html"), "bad");
    await assert.rejects(installPlugin(join(f.root, "new"), f.source), /differs/);
  } finally {
    await f.close();
  }
});
test("installer refuses unrelated directories and symlink destinations", async () => {
  const f = await fixture();
  try {
    await mkdir(f.target);
    await writeFile(join(f.target, "keep"), "mine");
    await assert.rejects(installPlugin(f.target, f.source), /no valid Forge receipt/);
    await symlink(f.target, join(f.root, "link"));
    await assert.rejects(installPlugin(join(f.root, "link"), f.source), /symlink/);
    assert.equal(await readFile(join(f.target, "keep"), "utf8"), "mine");
  } finally {
    await f.close();
  }
});
