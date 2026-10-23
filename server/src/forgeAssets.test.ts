// Run after build: node --test dist/forgeAssets.test.js
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assetRootFor, assetRoots, renderScreenshotResponse } from "./forgeAssets.js";

const cwd = "/work/project";
const env = {
  FIGMA_FORGE_ASSET_DIRS: `~/Pictures/gen${path.delimiter}/tmp/shots${path.delimiter}relative/ignored`,
};

test("roots: cwd first, ~ expanded, relative entries dropped, duplicates removed", () => {
  assert.deepEqual(assetRoots(env, cwd), [
    cwd,
    path.join(os.homedir(), "Pictures/gen"),
    "/tmp/shots",
  ]);
  assert.deepEqual(assetRoots({ FIGMA_FORGE_ASSET_DIRS: `${cwd}${path.delimiter}${cwd}` }, cwd), [
    cwd,
  ]);
  assert.deepEqual(assetRoots({}, cwd), [cwd]);
});

test("relative paths, URLs, data URIs and raw SVG resolve against the cwd", () => {
  for (const s of ["a.png", "https://x.test/a.png", "data:image/png;base64,AA", "<svg/>"]) {
    assert.equal(assetRootFor(s, env, cwd), cwd);
  }
});

test("absolute and ~ paths pick the containing allowed root", () => {
  assert.equal(assetRootFor("/work/project/sub/a.png", env, cwd), cwd);
  assert.equal(
    assetRootFor("~/Pictures/gen/x/a.png", env, cwd),
    path.join(os.homedir(), "Pictures/gen")
  );
  assert.equal(assetRootFor("/tmp/shots/a.png", env, cwd), "/tmp/shots");
});

test("paths outside every root, including ../ escapes and sibling prefixes, are rejected", () => {
  for (const s of [
    "/etc/passwd",
    "/tmp/shots/../secret.png",
    "/tmp/shotsevil/a.png",
    "/work/projectX/a.png",
  ]) {
    assert.throws(() => assetRootFor(s, env, cwd), /FIGMA_FORGE_ASSET_DIRS/);
  }
});

test("raster screenshots become image blocks plus metadata without base64", () => {
  const out = renderScreenshotResponse({
    type: "get_screenshot",
    requestId: "1",
    data: {
      exports: [
        { nodeId: "1:2", nodeName: "n", format: "PNG", base64: "QUJD", width: 2, height: 3 },
      ],
    },
  } as never);
  assert.deepEqual(out.content[0], { type: "image", data: "QUJD", mimeType: "image/png" });
  assert.equal(out.content.length, 2);
  assert.ok(!out.content[1].type.includes("image"));
  assert.ok(!JSON.stringify(out.content[1]).includes("QUJD"));
});

test("SVG/PDF exports and errors keep text output", () => {
  const svg = renderScreenshotResponse({
    data: { exports: [{ format: "SVG", base64: "PHN2Zz4=" }] },
  } as never);
  assert.equal(svg.content.length, 1);
  assert.ok(JSON.stringify(svg.content[0]).includes("PHN2Zz4="));
  const err = renderScreenshotResponse({ error: "No plugin connected" } as never);
  assert.equal(err.isError, true);
});
