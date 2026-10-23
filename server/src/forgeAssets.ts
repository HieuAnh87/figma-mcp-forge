// Forge additions: local asset roots beyond the server cwd, and screenshots as
// MCP image content. Kept out of tools.ts so upstream merges stay small.
import os from "node:os";
import path from "node:path";
import type { BridgeResponse } from "./types.js";

/** Colon-separated extra directories that file-based tools may read from and write to. */
export const ASSET_DIRS_ENV = "FIGMA_FORGE_ASSET_DIRS";

function expandHome(dir: string): string {
  if (dir === "~") return os.homedir();
  if (dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

/** The server cwd first, then every absolute directory listed in FIGMA_FORGE_ASSET_DIRS. */
export function assetRoots(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string[] {
  const extra = (env[ASSET_DIRS_ENV] ?? "")
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
    .map(expandHome)
    .filter((d) => path.isAbsolute(d))
    .map((d) => path.resolve(d));
  return [...new Set([path.resolve(cwd), ...extra])];
}

function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Picks the allowed root that contains `target`, for the upstream loaders to
 * validate against. Relative paths, URLs and data URIs resolve against the
 * cwd, exactly as before. The loaders still run their own containment and
 * symlink checks against the returned root.
 */
export function assetRootFor(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  const roots = assetRoots(env, cwd);
  const expanded = expandHome(target);
  if (!path.isAbsolute(expanded)) return roots[0];
  const resolved = path.resolve(expanded);
  const root = roots.find((r) => isInside(resolved, r));
  if (root) return root;
  throw new Error(
    `Path ${resolved} is outside the allowed directories (${roots.join(", ")}). ` +
      `Add its directory to ${ASSET_DIRS_ENV} (separated by "${path.delimiter}") in the MCP server env.`
  );
}

/** Expands a leading `~` so callers can pass `~/Pictures/...` paths. */
export function expandAssetPath(target: string): string {
  return expandHome(target);
}

type ScreenshotContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const IMAGE_MIME: Record<string, string> = { PNG: "image/png", JPG: "image/jpeg" };

/**
 * Turns a get_screenshot bridge response into MCP content: raster exports
 * become image blocks the model can see, followed by one text block of
 * metadata without base64. SVG and PDF exports keep the original JSON.
 */
export function renderScreenshotResponse(resp: BridgeResponse): {
  content: ScreenshotContent[];
  isError?: boolean;
} {
  if (resp.error) return { content: [{ type: "text", text: resp.error }], isError: true };
  const data = resp.data as { exports?: Array<Record<string, unknown>> } | undefined;
  const exports = Array.isArray(data?.exports) ? data.exports : undefined;
  if (!exports || exports.length === 0) {
    return { content: [{ type: "text", text: JSON.stringify(resp.data) }] };
  }
  const content: ScreenshotContent[] = [];
  const meta: Array<Record<string, unknown>> = [];
  for (const exp of exports) {
    const format = String(exp.format ?? "PNG");
    const mimeType = IMAGE_MIME[format];
    const { base64, ...rest } = exp;
    if (mimeType && typeof base64 === "string") {
      content.push({ type: "image", data: base64, mimeType });
      meta.push(rest);
    } else {
      meta.push(exp);
    }
  }
  content.push({ type: "text", text: JSON.stringify({ exports: meta }) });
  return { content };
}
