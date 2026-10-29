import { VERSION } from "./version.js";

export const PROTOCOL_VERSION = 1;
export const health = () => ({
  service: "figma-mcp-forge",
  status: "ok",
  protocolVersion: PROTOCOL_VERSION,
  version: VERSION,
});

export function isCompatibleHealth(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.service === "figma-mcp-forge" &&
    data.status === "ok" &&
    data.protocolVersion === PROTOCOL_VERSION &&
    data.version === VERSION
  );
}

/** null means unreachable; an answering but incompatible service must never be adopted. */
export async function probeLeader(url: string): Promise<ReturnType<typeof health> | null> {
  let response: Response;
  let data: unknown;
  try {
    response = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return null;
  }
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || !isCompatibleHealth(data)) {
    throw new Error(
      `Incompatible service at ${url}. Expected Forge ${VERSION}, protocol ${PROTOCOL_VERSION}. Restart all Forge MCP clients with the same version; check for another service using this port.`
    );
  }
  return data as ReturnType<typeof health>;
}
