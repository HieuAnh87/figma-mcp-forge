import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { Bridge } from "./bridge.js";
import { Node } from "./node.js";
import { Leader } from "./leader.js";
import { Follower } from "./follower.js";
import { Election } from "./election.js";
import { VERSION } from "./version.js";
import { health, probeLeader } from "./health.js";

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}
async function bridgeFixture(timeout = 1000) {
  const bridge = new Bridge(timeout);
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => bridge.handleUpgrade(req, socket, head));
  const port = await listen(server);
  const sockets: WebSocket[] = [];
  return {
    bridge,
    async connect(key: string, version = VERSION) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/?fileKey=${key}&version=${version}&protocol=1`
      );
      sockets.push(ws);
      await once(ws, "open");
      return ws;
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      bridge.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
function reply(ws: WebSocket, request: any, data: unknown) {
  ws.send(JSON.stringify({ type: request.type, requestId: request.requestId, data }));
}
async function request(ws: WebSocket) {
  const [bytes] = await once(ws, "message");
  return JSON.parse(bytes.toString());
}

test("responses are scoped to originating socket and tool type; files require explicit routing", async () => {
  const f = await bridgeFixture();
  try {
    const a = await f.connect("a"),
      b = await f.connect("b");
    await assert.rejects(f.bridge.send("get_metadata"), /Multiple files/);
    const received = request(a);
    let settled = false;
    const result = f.bridge.send("get_metadata", undefined, "a").then((r) => {
      settled = true;
      return r;
    });
    const req = await received;
    reply(b, req, "wrong-file");
    reply(a, { ...req, type: "get_document" }, "wrong-type");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(settled, false);
    reply(a, req, "correct");
    assert.equal((await result).data, "correct");
  } finally {
    await f.close();
  }
});

test("disconnect rejects pending work; same-file replacement preserves new connection", async () => {
  const f = await bridgeFixture();
  try {
    const old = await f.connect("a");
    const got = request(old);
    const pending = assert.rejects(
      f.bridge.send("get_metadata", undefined, "a"),
      /replaced|disconnected/
    );
    await got;
    const fresh = await f.connect("a");
    await pending;
    const received = request(fresh);
    const p = f.bridge.send("get_metadata", undefined, "a");
    reply(fresh, await received, "new");
    assert.equal((await p).data, "new");
    const next = request(fresh);
    const lost = assert.rejects(f.bridge.send("get_metadata", undefined, "a"), /disconnected/);
    await next;
    fresh.close();
    await lost;
  } finally {
    await f.close();
  }
});

test("late responses after timeout cannot resolve newer work and edits are not automatically replayed", async () => {
  const f = await bridgeFixture(40);
  try {
    const ws = await f.connect("a");
    const first = request(ws);
    const p = assert.rejects(f.bridge.send("get_metadata", undefined, "a"), /may still be running/);
    const stale = await first;
    await p;
    const second = request(ws);
    const next = f.bridge.send("get_metadata", undefined, "a");
    const fresh = await second;
    assert.notEqual(stale.requestId, fresh.requestId);
    reply(ws, stale, "late");
    reply(ws, fresh, "fresh");
    assert.equal((await next).data, "fresh");
  } finally {
    await f.close();
  }
});

test("old plugins remain visible for diagnosis but cannot execute operations", async () => {
  const f = await bridgeFixture();
  try {
    await f.connect("a", "0.0.25");
    assert.equal(f.bridge.listConnectedFiles()[0].compatible, false);
    await assert.rejects(f.bridge.send("get_metadata", undefined, "a"), /incompatible/);
  } finally {
    await f.close();
  }
});

test("health rejects unrelated services and mismatched versions rather than adopting a leader", async () => {
  for (const payload of [
    { status: "ok" },
    { ...health(), version: "99.0.0" },
    { ...health(), protocolVersion: 999 },
  ]) {
    const server = http.createServer((req, res) => res.end(JSON.stringify(payload)));
    const port = await listen(server);
    const node = new Node(port, "127.0.0.1");
    const election = new Election(port, node);
    try {
      await assert.rejects(election.start(), /Incompatible service/);
      assert.equal(node.roleName, "UNKNOWN");
    } finally {
      election.stop();
      node.stop();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});

test("failed leader binding releases heartbeat timers on every attempt", async (t) => {
  const server = http.createServer();
  const port = await listen(server);
  const active = new Set<ReturnType<typeof setInterval>>();
  const realSet = globalThis.setInterval,
    realClear = globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => {
    const id = realSet(...args);
    active.add(id);
    return id;
  });
  t.mock.method(globalThis, "clearInterval", (id: ReturnType<typeof setInterval>) => {
    active.delete(id);
    realClear(id);
  });
  const node = new Node(port, "127.0.0.1");
  try {
    for (let i = 0; i < 3; i++) await assert.rejects(node.becomeLeader(), /already in use/);
    node.stop();
    assert.equal(active.size, 0);
  } finally {
    for (const id of active) realClear(id);
    t.mock.restoreAll();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("two follower clients route requests to distinct plugin files through a real leader", async () => {
  const reserve = http.createServer();
  const port = await listen(reserve);
  await new Promise<void>((r) => reserve.close(() => r()));
  const leader = new Leader(port, "127.0.0.1");
  await leader.start();
  const sockets: WebSocket[] = [];
  try {
    for (const key of ["a", "b"]) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws?fileKey=${key}&version=${VERSION}&protocol=1`
      );
      sockets.push(ws);
      await once(ws, "open");
      ws.on("message", (bytes) => reply(ws, JSON.parse(bytes.toString()), key));
    }
    const a = new Follower(`http://127.0.0.1:${port}`),
      b = new Follower(`http://127.0.0.1:${port}`);
    assert.equal((await probeLeader(`http://127.0.0.1:${port}`))?.version, VERSION);
    const result = await Promise.all([
      a.send("get_metadata", undefined, "a"),
      b.send("get_metadata", undefined, "b"),
    ]);
    assert.deepEqual(
      result.map((r) => r.data),
      ["a", "b"]
    );
    assert.equal((await a.listConnectedFiles()).length, 2);
  } finally {
    for (const ws of sockets) ws.terminate();
    leader.stop();
  }
});

test("follower takes over after leader exit and accepts a reconnected plugin", async () => {
  const reserve = http.createServer();
  const port = await listen(reserve);
  await new Promise<void>((r) => reserve.close(() => r()));
  const leader = new Leader(port, "127.0.0.1");
  await leader.start();
  const node = new Node(port, "127.0.0.1");
  const election = new Election(port, node);
  let ws: WebSocket | undefined;
  try {
    await election.start();
    assert.equal(node.roleName, "FOLLOWER");
    leader.stop();
    const deadline = Date.now() + 7000;
    while (String(node.roleName) !== "LEADER" && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(node.roleName, "LEADER");
    ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?fileKey=reconnected&version=${VERSION}&protocol=1`
    );
    await once(ws, "open");
    const received = request(ws);
    const pending = node.send("get_metadata", undefined, "reconnected");
    reply(ws, await received, "recovered");
    assert.equal((await pending).data, "recovered");
  } finally {
    ws?.terminate();
    election.stop();
    node.stop();
  }
});
