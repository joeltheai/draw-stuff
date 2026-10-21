import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CanvasSync } from "../src/sync";
import { appendPoint, type Gesture } from "../src/gesture";
import { ClientMessageSchema, MAX_POINTS, MAX_ROOM_POINTS, type Command, type ServerMessage, type Stroke } from "../shared/protocol";
import { handleCommand, RoomError, RoomStore, RoomTransport } from "../worker/room";

const point = { x: 0.2, y: 0.3 };
const stroke = (id: string, author = "alice", groupId = id): Stroke => ({ id, groupId, author, points: [point] });
class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
class FakeSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Command[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
  message(message: ServerMessage) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
}
function client(storage = new MemoryStorage()) {
  const socket = new FakeSocket();
  const notices: string[] = [];
  const sync = new CanvasSync({ room: "test", token: crypto.randomUUID(), storage, url: "http://localhost", socket: () => socket as unknown as WebSocket, callbacks: { changed() {}, notice(message) { notices.push(message); } } });
  sync.start();
  return { sync, socket, storage, notices, ready(strokes: Stroke[] = [], epoch = 0) {
    socket.message({ type: "snapshot-start", author: "alice", users: 2, epoch });
    for (const stroke of strokes) socket.message({ type: "snapshot-stroke", stroke });
    socket.message({ type: "ready" });
  } };
}

test("offline drawings survive reload and retire only after a server acknowledgement", () => {
  const first = client();
  first.sync.commit(stroke("offline"));
  assert.equal(first.socket.sent.length, 0);
  first.sync.stop();
  const restored = client(first.storage);
  restored.ready();
  assert.equal(restored.sync.strokes.length, 1);
  const command = restored.socket.sent[0];
  assert.equal(command.type, "commit");
  restored.socket.message({ type: "stroke", epoch: 0, stroke: stroke("offline") });
  assert.equal(restored.sync.strokes.length, 1, "own echo does not duplicate a drawing");
  assert.equal(restored.sync.pending.length, 1, "broadcast is not an acknowledgement");
  restored.socket.message({ type: "ack", opId: command.opId });
  assert.equal(restored.sync.pending.length, 0);
  restored.sync.stop();
});

test("a lost acknowledgement safely retries against a reconnect snapshot", () => {
  const first = client(); first.ready();
  first.sync.commit(stroke("accepted"));
  const opId = first.sync.pending[0].opId;
  first.sync.stop();
  const restored = client(first.storage);
  restored.ready([stroke("accepted")]);
  assert.equal(restored.sync.strokes.length, 1);
  assert.equal(restored.socket.sent[0].opId, opId);
  restored.socket.message({ type: "ack", opId });
  assert.equal(restored.sync.strokes.length, 1);
  assert.equal(restored.sync.pending.length, 0);
  restored.sync.stop();
});

test("a rejection keeps the local drawing and displays its reason; undo can discard it", () => {
  const c = client(); c.ready(); c.sync.commit(stroke("unsaved"));
  c.socket.message({ type: "error", code: "capacity", opId: c.sync.pending[0].opId, retryable: false, message: "Canvas full" });
  assert.equal(c.sync.pending.length, 1);
  assert.equal(c.sync.strokes.length, 1);
  assert.equal(c.sync.blocked, true);
  assert.match(c.notices[0], /Canvas full/);
  assert.match(c.storage.getItem("draw-stuff:outbox:v2:test")!, /unsaved/);
  c.sync.undo();
  assert.equal(c.sync.strokes.length, 0);
  assert.equal(c.socket.sent.at(-1)?.type, "undo");
  c.sync.stop();
});

test("clear still reaches the server when a drawing already in flight is rejected", () => {
  const c = client(); c.ready(); c.sync.commit(stroke("in-flight"));
  const rejected = c.sync.pending[0].opId;
  c.sync.clear();
  c.socket.message({ type: "error", code: "capacity", opId: rejected, retryable: false, message: "Canvas full" });
  assert.equal(c.socket.sent.at(-1)?.type, "clear");
  assert.equal(c.sync.strokes.length, 0);
  c.sync.stop();
});

test("undo selects the last personal gesture, including all its segments", () => {
  const c = client();
  c.ready([stroke("segment-1", "alice", "gesture"), stroke("segment-2", "alice", "gesture"), stroke("peer", "bob")]);
  c.sync.undo();
  const command = c.socket.sent.at(-1)!;
  assert.equal(command.type, "undo");
  assert.equal(command.type === "undo" && command.groupId, "gesture");
  assert.deepEqual(c.sync.strokes.map(s => s.id), ["peer"]);
  c.sync.stop();
});

test("live previews render before commit, and commit replaces rather than duplicates them", () => {
  const c = client(); c.ready();
  c.socket.message({ type: "preview", id: "live", groupId: "live", author: "bob", offset: 0, epoch: 0, points: [point] });
  assert.equal(c.sync.strokes.length, 1);
  c.socket.message({ type: "preview", id: "live", groupId: "live", author: "bob", offset: 1, epoch: 0, points: [{ x: .4, y: .5 }] });
  assert.equal(c.sync.strokes[0].points.length, 2);
  c.socket.message({ type: "stroke", epoch: 0, stroke: stroke("live", "bob") });
  assert.equal(c.sync.strokes.length, 1);
  assert.equal(c.sync.previews.size, 0);
  c.sync.stop();
});

test("two tabs with the same browser identity still see each other's live previews", () => {
  const c = client(); c.ready();
  c.socket.message({ type: "preview", id: "other-tab", groupId: "gesture", author: "alice", offset: 0, epoch: 0, points: [point] });
  assert.equal(c.sync.strokes[0].id, "other-tab");
  c.sync.preview(stroke("local-active"), 0);
  c.socket.message({ type: "preview", id: "local-active", groupId: "local-active", author: "alice", offset: 0, epoch: 0, points: [point] });
  assert.equal(c.sync.previews.has("local-active"), false);
  c.sync.stop();
});

test("a room reset rebases offline drawings without replaying stale clear actions", () => {
  const first = client(); first.ready([], 0); first.sync.clear(); first.sync.commit(stroke("after-clear")); first.sync.stop();
  const restored = client(first.storage); restored.ready([], 2);
  assert.equal(restored.sync.pending.length, 1);
  assert.equal(restored.sync.pending[0].type, "commit");
  assert.equal(restored.socket.sent[0].epoch, 2);
  restored.sync.stop();
});

test("shared schemas reject invalid coordinates and oversized segments", () => {
  const decode = Schema.decodeUnknownSync(ClientMessageSchema);
  assert.throws(() => decode({ type: "commit", opId: "x", epoch: 0, stroke: { ...stroke("x"), points: [{ x: -1, y: 0 }] } }));
  assert.throws(() => decode({ type: "commit", opId: "x", epoch: 0, stroke: { ...stroke("x"), points: Array(MAX_POINTS + 1).fill(point) } }));
});

test("a gesture longer than the segment limit keeps continuity and one undo group", () => {
  let active: Gesture = { id: "first", groupId: "one-gesture", points: [{ x: 0, y: 0 }], sent: 0, pointerId: 1 };
  const segments = [];
  for (let i = 1; i <= MAX_POINTS * 2; i++) {
    const result = appendPoint(active, { x: i / (MAX_POINTS * 2), y: .5 });
    active = result.active;
    if (result.completed) segments.push(result.completed);
  }
  segments.push(active);
  assert.equal(segments.length, 3);
  for (let i = 0; i < segments.length; i++) {
    Schema.decodeUnknownSync(ClientMessageSchema)({ type: "commit", opId: `part-${i}`, epoch: 0, stroke: segments[i] });
    assert.equal(segments[i].groupId, "one-gesture");
    if (i) assert.deepEqual(segments[i].points[0], segments[i - 1].points.at(-1));
  }
});

function room() {
  let epoch = 0;
  const saved = new Map<string, Stroke>();
  const events: ServerMessage[] = [];
  let unavailable = false;
  const store = {
    initialize: Effect.void,
    epoch: Effect.sync(() => epoch),
    list: Effect.sync(() => [...saved.values()]),
    get: (id: string) => Effect.sync(() => saved.get(id)),
    capacity: Effect.sync(() => ({ count: saved.size, points: [...saved.values()].reduce((sum, s) => sum + s.points.length, 0) })),
    save: (stroke: Stroke) => Effect.suspend(() => unavailable ? Effect.fail(new RoomError({ message: "Storage unavailable", retryable: true })) : Effect.sync(() => { saved.set(stroke.id, stroke); })),
    undo: (group: string, author: string) => Effect.sync(() => { for (const [id, s] of saved) if (s.groupId === group && s.author === author) saved.delete(id); }),
    clear: Effect.sync(() => { saved.clear(); return ++epoch; }),
  };
  return { saved, events, unavailable() { unavailable = true; }, run(command: Command, author = "alice") {
    return Effect.runSync(handleCommand(command, author).pipe(Effect.provideService(RoomStore, store), Effect.provideService(RoomTransport, { broadcast: event => Effect.sync(() => { events.push(event); }) })));
  } };
}
const commit = (id: string): Command => ({ type: "commit", opId: id, epoch: 0, stroke: stroke(id) });

test("server commits are idempotent and cannot overwrite another author's stroke", () => {
  const r = room(); r.run(commit("same")); r.run(commit("same"));
  assert.equal(r.saved.size, 1); assert.equal(r.events.length, 1);
  assert.throws(() => r.run(commit("same"), "bob"));
  assert.equal(r.saved.get("same")?.author, "alice");
});

test("server ownership prevents undoing another person's gesture", () => {
  const r = room(); r.run(commit("alice")); r.run(commit("bob"), "bob");
  r.run({ type: "undo", opId: "undo", epoch: 0, groupId: "bob" }, "alice");
  assert.equal(r.saved.size, 2);
  r.run({ type: "undo", opId: "undo-own", epoch: 0, groupId: "alice" }, "alice");
  assert.deepEqual([...r.saved.keys()], ["bob"]);
});

test("stale clears, room capacity, and storage failures produce typed failures", () => {
  const r = room(); r.run({ type: "clear", opId: "clear", epoch: 0 });
  assert.throws(() => r.run({ type: "clear", opId: "retry-clear", epoch: 0 }));
  const full = room(); full.saved.set("full", { ...stroke("full"), points: Array(MAX_ROOM_POINTS).fill(point) });
  assert.throws(() => full.run(commit("new")));
  const failed = room(); failed.unavailable();
  assert.throws(() => failed.run(commit("failed")));
  assert.equal(failed.events.length, 0);
  assert.equal(failed.saved.size, 0);
});
