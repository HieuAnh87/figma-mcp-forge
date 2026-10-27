import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(
  new URL("../../plugin/src/main/forgeQuality.ts", import.meta.url),
  "utf8"
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 },
}).outputText;
const quality = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
function fixture() {
  const data = new Map<string, string>();
  const page: any = { id: "p", name: "Page", type: "PAGE", children: [] };
  const nodes = new Map<string, any>([["p", page]]);
  (globalThis as any).figma = {
    currentPage: page,
    root: {
      name: "Test",
      getPluginData: (k: string) => data.get(k) || "",
      setPluginData: (k: string, v: string) => data.set(k, v),
    },
    getNodeByIdAsync: async (id: string) => nodes.get(id) || null,
    listAvailableFontsAsync: async () => [
      { fontName: { family: "SF Pro Text", style: "Regular" } },
    ],
    loadFontAsync: async () => {},
  };
  return { data, page, nodes };
}
test("preflight distinguishes exact font faces; does not create nodes", async () => {
  const f = fixture();
  const r = await quality.qualityPreflight({
    fonts: [
      { family: "SF Pro Text", style: "Regular" },
      { family: "Missing", style: "Bold" },
    ],
    roots: ["p"],
  });
  assert.equal(r.ready, false);
  assert.equal(r.fonts[0].loadable, true);
  assert.equal(r.fonts[1].installed, false);
  assert.equal(f.nodes.size, 1);
  assert.equal(f.data.size, 0);
});
test("audit reports bounded findings, dead reactions and broken components", async () => {
  const f = fixture();
  const text = {
    id: "t",
    name: "Text",
    type: "TEXT",
    visible: true,
    characters: "hello",
    width: 0,
    height: 12,
    hasMissingFont: true,
    textStyleId: "",
    fontSize: 13,
  };
  const instance = {
    id: "i",
    name: "Instance",
    type: "INSTANCE",
    visible: true,
    getMainComponentAsync: async () => null,
    reactions: [{ actions: [{ type: "NODE", destinationId: "gone" }] }],
  };
  f.page.children = [text, instance];
  const r = await quality.qualityAudit({ allowedFontSizes: [12, 14], maxIssues: 2 });
  assert.equal(r.complete, true);
  assert.equal(r.visited, 3);
  assert.equal(r.issueCount, 6);
  assert.equal(r.issues.length, 2);
  assert.equal(r.issuesTruncated, true);
  assert.equal(r.counts.dead_reaction, 1);
  const partial = await quality.qualityAudit({ maxNodes: 1 });
  assert.equal(partial.complete, false);
});
test("checkpoint is retry-safe, revision checked and refuses nonexistent nodes", async () => {
  fixture();
  const args = {
    key: "chat",
    expectedRevision: 0,
    operationId: "batch-1",
    roots: ["p"],
    note: "audited",
  };
  assert.equal((await quality.checkpointGet({ key: "chat" })).revision, 0);
  const first = await quality.checkpointCommit(args);
  assert.equal(first.revision, 1);
  assert.equal((await quality.checkpointCommit(args)).replayed, true);
  await assert.rejects(
    quality.checkpointCommit({ ...args, note: "different" }),
    /different content/
  );
  await assert.rejects(
    quality.checkpointCommit({ ...args, operationId: "batch-2" }),
    /Revision conflict/
  );
  await assert.rejects(
    quality.checkpointCommit({
      ...args,
      operationId: "batch-2",
      expectedRevision: 1,
      roots: ["missing"],
    }),
    /Node not found/
  );
  assert.equal((await quality.checkpointGet({ key: "chat" })).revision, 1);
});
test("concurrent checkpoint writers cannot both commit the same revision", async () => {
  fixture();
  const args = { key: "chat", expectedRevision: 0, roots: ["p"] };
  const results = await Promise.allSettled([
    quality.checkpointCommit({ ...args, operationId: "one" }),
    quality.checkpointCommit({ ...args, operationId: "two" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await quality.checkpointGet({ key: "chat" })).revision, 1);
});

test("slow Figma component lookup returns an incomplete audit within budget", async () => {
  const f = fixture();
  f.page.children = [
    {
      id: "slow",
      name: "Remote instance",
      type: "INSTANCE",
      getMainComponentAsync: () => new Promise(() => {}),
    },
  ];
  const started = Date.now();
  const result = await quality.qualityAudit({ maxDurationMs: 20 });
  assert.equal(result.complete, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.issueCount, 0); // timeout is not evidence that the component is broken
  assert.ok(Date.now() - started < 1000);
});
