import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MAX_ROOM_POINTS, MAX_STROKES, type Command, type Stroke, type ServerMessage } from "../shared/protocol";

export class RoomError extends Data.TaggedError("RoomError")<{ message: string; retryable: boolean; code?: string }> {}
const fail = (message: string, code = "invalid") => Effect.fail(new RoomError({ message, retryable: false, code }));
const storageEffect = <A>(run: () => A) => Effect.try({
  try: run,
  catch: () => new RoomError({ message: "Room storage is unavailable. Your drawing will retry.", retryable: true }),
});

export function makeStore(storage: DurableObjectStorage) {
  const sql = storage.sql;
  const readEpoch = () => sql.exec<{ value: number }>("SELECT value FROM room_state WHERE key = 'epoch'").one().value;
  const readStroke = (row: { id: string; data: string }): Stroke => {
    const old = JSON.parse(row.data);
    return { ...old, id: row.id, groupId: old.groupId || row.id, author: old.author || "legacy" };
  };
  return {
    initialize: storageEffect(() => {
      sql.exec("CREATE TABLE IF NOT EXISTS strokes (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS room_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
      sql.exec("INSERT OR IGNORE INTO room_state (key, value) VALUES ('epoch', 0)");
    }),
    epoch: storageEffect(readEpoch),
    list: storageEffect(() => sql.exec<{ id: string; data: string }>("SELECT id, data FROM strokes ORDER BY created_at, rowid").toArray().map(readStroke)),
    get: (id: string) => storageEffect(() => {
      const row = sql.exec<{ id: string; data: string }>("SELECT id, data FROM strokes WHERE id = ?", id).toArray()[0];
      return row ? readStroke(row) : undefined;
    }),
    capacity: storageEffect(() => sql.exec<{ count: number; points: number }>("SELECT COUNT(*) AS count, COALESCE(SUM(json_array_length(data, '$.points')), 0) AS points FROM strokes").one()),
    save: (stroke: Stroke) => storageEffect(() => {
      sql.exec("INSERT INTO strokes (id, data, created_at) VALUES (?, ?, ?)", stroke.id, JSON.stringify(stroke), Date.now());
    }),
    undo: (groupId: string, author: string) => storageEffect(() => {
      sql.exec("DELETE FROM strokes WHERE json_extract(data, '$.groupId') = ? AND json_extract(data, '$.author') = ?", groupId, author);
    }),
    clear: storageEffect(() => storage.transactionSync(() => {
      sql.exec("DELETE FROM strokes");
      sql.exec("UPDATE room_state SET value = value + 1 WHERE key = 'epoch'");
      return readEpoch();
    })),
  };
}

export class RoomStore extends Context.Service<RoomStore, ReturnType<typeof makeStore>>()("draw/RoomStore") {}
export class RoomTransport extends Context.Service<RoomTransport, {
  broadcast: (message: ServerMessage) => Effect.Effect<void>;
}>()("draw/RoomTransport") {}

export const handleCommand = (command: Command, author: string) => Effect.gen(function* () {
  const store = yield* RoomStore;
  const transport = yield* RoomTransport;
  const epoch = yield* store.epoch;
  if (command.epoch !== epoch) return yield* fail("The canvas changed. Reconnecting to sync your drawing.", "stale");
  if (command.type === "commit") {
    const existing = yield* store.get(command.stroke.id);
    if (existing) {
      if (existing.author !== author || existing.groupId !== command.stroke.groupId || JSON.stringify(existing.points) !== JSON.stringify(command.stroke.points)) return yield* fail("This stroke conflicts with an existing drawing.");
      return;
    }
    const capacity = yield* store.capacity;
    if (capacity.count >= MAX_STROKES || capacity.points + command.stroke.points.length > MAX_ROOM_POINTS) return yield* fail("This canvas is full. Undo a drawing or clear the canvas to make space.", "capacity");
    const stroke: Stroke = { ...command.stroke, author };
    yield* store.save(stroke);
    yield* transport.broadcast({ type: "stroke", epoch, stroke });
  } else if (command.type === "undo") {
    yield* store.undo(command.groupId, author);
    yield* transport.broadcast({ type: "undo", epoch, groupId: command.groupId, author });
  } else {
    const nextEpoch = yield* store.clear;
    yield* transport.broadcast({ type: "clear", epoch: nextEpoch });
  }
});
