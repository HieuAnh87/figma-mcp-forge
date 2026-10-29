import { randomUUID } from "node:crypto";
import { VERSION } from "./version.js";
import { PROTOCOL_VERSION } from "./health.js";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { BridgeRequest, BridgeResponse, ConnectedFile } from "./types.js";

interface PendingRequest {
  resolve: (resp: BridgeResponse) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  ws: WebSocket;
  type: string;
}

interface ConnectionEntry {
  ws: WebSocket;
  fileKey: string;
  fileName: string;
  isAlive: boolean;
  pluginVersion: string | null;
  protocolVersion: number | null;
}

export class Bridge {
  private wss: WebSocketServer;
  private connections = new Map<string, ConnectionEntry>();
  private pending = new Map<string, PendingRequest>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private requestTimeoutMs = 180_000) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("error", (err) => {
      console.error("WebSocketServer error:", err);
    });

    this.pingTimer = setInterval(() => {
      for (const [fileKey, entry] of this.connections) {
        if (!entry.isAlive) {
          entry.ws.terminate();
          this.connections.delete(fileKey);
          console.error(`Plugin dead (no pong): ${entry.fileName} (${fileKey})`);
          continue;
        }
        entry.isAlive = false;
        entry.ws.ping();
      }
    }, 30_000);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (request.url == undefined) {
      console.error("Plugin connected without url, rejecting");
      socket.destroy();
      return;
    }

    const url = new URL(request.url, "http://localhost");
    const { fileKey, fileName = "Unknown" } = Object.fromEntries(url.searchParams);

    if (!fileKey) {
      console.error("Plugin connected without fileKey, rejecting");
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleConnection(
        ws,
        fileKey,
        fileName,
        url.searchParams.get("version"),
        url.searchParams.get("protocol")
      );
    });
  }

  private handleConnection(
    ws: WebSocket,
    fileKey: string,
    fileName: string,
    pluginVersion: string | null,
    protocol: string | null
  ): void {
    // Replace existing connection for the same file
    const existing = this.connections.get(fileKey);
    if (existing) {
      this.rejectPendingForSocket(
        existing.ws,
        "Plugin connection replaced; inspect live nodes before retrying edits"
      );
      existing.ws.close();
    }
    this.connections.set(fileKey, {
      ws,
      fileKey,
      fileName,
      isAlive: true,
      pluginVersion,
      protocolVersion: protocol === null ? null : Number(protocol),
    });
    console.error(`Plugin connected: ${fileName} (${fileKey})`);

    ws.on("pong", () => {
      const entry = this.connections.get(fileKey);
      if (entry && entry.ws === ws) entry.isAlive = true;
    });

    ws.on("message", (data) => {
      try {
        const resp: BridgeResponse = JSON.parse(data.toString());
        const pending = this.pending.get(resp.requestId);
        if (
          pending &&
          pending.ws === ws &&
          resp.type === pending.type &&
          this.connections.get(fileKey)?.ws === ws
        ) {
          clearTimeout(pending.timeout);
          this.pending.delete(resp.requestId);
          pending.resolve(resp);
        }
      } catch {
        console.error("Invalid response from plugin");
      }
    });

    ws.on("close", () => {
      const current = this.connections.get(fileKey);
      if (current?.ws === ws) {
        this.connections.delete(fileKey);
        console.error(`Plugin disconnected: ${fileName} (${fileKey})`);
      }
      this.rejectPendingForSocket(ws, `Plugin disconnected: ${fileName} (${fileKey})`);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
      const current = this.connections.get(fileKey);
      if (current?.ws === ws) {
        this.connections.delete(fileKey);
      }
      this.rejectPendingForSocket(ws, `Plugin connection error (${fileName}): ${err.message}`);
    });
  }

  private rejectPendingForSocket(ws: WebSocket, reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.ws === ws) {
        clearTimeout(p.timeout);
        this.pending.delete(id);
        p.reject(new Error(reason));
      }
    }
  }

  /**
   * Resolve which connection to use.
   * - If fileKey is provided, use that specific connection.
   * - If only one file is connected and no fileKey given, use it (backward compat).
   * - If multiple files connected and no fileKey, throw with a helpful message.
   */
  private resolveConnection(fileKey?: string): WebSocket {
    if (fileKey) {
      const entry = this.connections.get(fileKey);
      if (!entry) {
        const available = this.listConnectedFiles();
        const hint =
          available.length > 0
            ? ` Connected files: ${available.map((f) => `"${f.fileName}" (fileKey: ${f.fileKey})`).join(", ")}`
            : " No files are currently connected.";
        throw new Error(`No plugin connected for fileKey "${fileKey}".${hint}`);
      }
      this.requireCompatible(entry);
      return entry.ws;
    }

    if (this.connections.size === 0) {
      throw new Error("No plugin connected. Open a Figma file and run the bridge plugin.");
    }

    if (this.connections.size === 1) {
      const entry = this.connections.values().next().value!;
      this.requireCompatible(entry);
      return entry.ws;
    }

    const files = this.listConnectedFiles();
    throw new Error(
      `Multiple files connected. Specify a fileKey to choose which file to query. Connected files: ${files.map((f) => `"${f.fileName}" (fileKey: ${f.fileKey})`).join(", ")}. Use the list_files tool to see all connected files.`
    );
  }

  private requireCompatible(entry: ConnectionEntry): void {
    if (entry.pluginVersion !== VERSION || entry.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `Plugin ${entry.fileName} is incompatible (version ${entry.pluginVersion ?? "unknown"}). Install/open the Forge ${VERSION} plugin and restart it before editing.`
      );
    }
  }

  listConnectedFiles(): ConnectedFile[] {
    return [...this.connections.values()].map((entry) => ({
      fileKey: entry.fileKey,
      fileName: entry.fileName,
      pluginVersion: entry.pluginVersion,
      protocolVersion: entry.protocolVersion,
      compatible: entry.pluginVersion === VERSION && entry.protocolVersion === PROTOCOL_VERSION,
    }));
  }

  send(requestType: string, nodeIds?: string[], fileKey?: string): Promise<BridgeResponse> {
    return this.sendWithParams(requestType, nodeIds, undefined, fileKey);
  }

  sendWithParams(
    requestType: string,
    nodeIds?: string[],
    params?: Record<string, unknown>,
    fileKey?: string
  ): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      let conn: WebSocket;
      try {
        conn = this.resolveConnection(fileKey);
      } catch (err) {
        reject(err);
        return;
      }

      if (conn.readyState !== WebSocket.OPEN) {
        reject(new Error("Plugin not connected"));
        return;
      }

      const requestId = this.nextId();
      const request: BridgeRequest = {
        type: requestType,
        requestId,
      };
      if (nodeIds && nodeIds.length > 0) {
        request.nodeIds = nodeIds;
      }
      if (params && Object.keys(params).length > 0) {
        request.params = params;
      }

      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `Request timed out after ${this.requestTimeoutMs}ms. The plugin operation may still be running; inspect live nodes before retrying edits.`
          )
        );
      }, this.requestTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timeout, ws: conn, type: requestType });

      conn.send(JSON.stringify(request), (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pending.delete(requestId);
          reject(err);
        }
      });
    });
  }

  private nextId(): string {
    return randomUUID();
  }

  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    // Reject all pending requests
    for (const [id, { reject, timeout }] of this.pending) {
      clearTimeout(timeout);
      reject(new Error("Bridge closed"));
    }
    this.pending.clear();

    for (const [, entry] of this.connections) {
      entry.ws.close();
    }
    this.connections.clear();
    this.wss.close();
  }
}
