// Live check of FIGMA_FORGE_ASSET_DIRS and image screenshots against an open plugin.
// Starts a second server process (it joins as a follower of any running leader).
// Usage: node scripts/smoke-assets.mjs <fileKey> <imagePath> <screenshotNodeId>
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const [fileKey, imagePath, nodeId] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(os.homedir(), ".cache/forge-agents/shots");
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(here, "../server/dist/index.js")],
  cwd: path.join(os.homedir(), ".cache/forge-agents/cwd"),
  env: {
    ...process.env,
    FIGMA_BRIDGE_ENABLE_RUN_SCRIPT: "1",
    FIGMA_FORGE_ASSET_DIRS: `${path.dirname(imagePath)}:~/.cache/forge-agents/shots`,
  },
});
const client = new Client({ name: "smoke-assets", version: "0" });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: { fileKey, ...args } });
const text = (r) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

const img = await call("create_image", {
  source: imagePath,
  name: "smoke/asset-dir image",
  x: 3100,
  y: 0,
  width: 160,
  height: 100,
});
console.log("create_image outside cwd:", img.isError ? "FAIL " + text(img) : "ok " + text(img));
const denied = await call("create_image", { source: "/etc/hosts" });
console.log(
  "create_image /etc/hosts denied:",
  denied.isError ? "ok " + text(denied).slice(0, 90) : "FAIL"
);
const saved = await call("save_screenshots", {
  items: [
    { nodeId, outputPath: "~/.cache/forge-agents/shots/smoke.png", scale: 0.5 },
    { nodeId, outputPath: "/etc/forge-smoke.png" },
  ],
});
const s = JSON.parse(text(saved));
console.log(
  "save_screenshots:",
  s.results
    .map(
      (r) =>
        `${r.success ? "ok" : "denied"} ${r.outputPath}${r.error ? " — " + r.error.slice(0, 60) : ""}`
    )
    .join(" | ")
);
const shot = await call("get_screenshot", { nodeIds: [nodeId], scale: 0.25 });
console.log(
  "get_screenshot content:",
  shot.content
    .map(
      (c) =>
        c.type +
        (c.type === "image"
          ? `(${c.mimeType}, ${c.data.length} b64 chars)`
          : `(${c.text.length} chars)`)
    )
    .join(", ")
);
if (!img.isError) {
  const id = JSON.parse(text(img)).nodeId;
  const rm = await call("run_script", {
    code: `const n = await figma.getNodeByIdAsync(${JSON.stringify(id)}); n?.remove(); return !!n;`,
    allowRemove: true,
  });
  console.log("cleanup:", text(rm));
}
await client.close();
