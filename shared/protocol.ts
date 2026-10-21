import * as Schema from "effect/Schema";

export const MAX_POINTS = 3_000;
export const MAX_STROKES = 2_000;
export const MAX_ROOM_POINTS = 100_000;
export const MAX_PREVIEW_POINTS = 256;
const Id = Schema.String.check(Schema.isBetweenLength(1, 80));
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Coordinate = Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 1 }));
export const PointSchema = Schema.Struct({ x: Coordinate, y: Coordinate });
const Points = Schema.Array(PointSchema).check(Schema.isBetweenLength(1, MAX_POINTS));
export const DraftSchema = Schema.Struct({ id: Id, groupId: Id, points: Points });
export const StrokeSchema = Schema.Struct({ ...DraftSchema.fields, author: Id });
const operation = { opId: Id, epoch: Count };
export const CommandSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("commit"), ...operation, stroke: DraftSchema }),
  Schema.Struct({ type: Schema.Literal("undo"), ...operation, groupId: Id }),
  Schema.Struct({ type: Schema.Literal("clear"), ...operation }),
]);
export const PreviewSchema = Schema.Struct({
  type: Schema.Literal("preview"), epoch: Count, id: Id, groupId: Id, offset: Count,
  points: Schema.Array(PointSchema).check(Schema.isBetweenLength(1, MAX_PREVIEW_POINTS)),
});
export const ClientMessageSchema = Schema.Union([CommandSchema, PreviewSchema]);
export const ServerMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot-start"), epoch: Count, author: Id, users: Count }),
  Schema.Struct({ type: Schema.Literal("snapshot-stroke"), stroke: StrokeSchema }),
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("stroke"), epoch: Count, stroke: StrokeSchema }),
  Schema.Struct({ ...PreviewSchema.fields, author: Id }),
  Schema.Struct({ type: Schema.Literal("discard-preview"), id: Id, author: Id }),
  Schema.Struct({ type: Schema.Literal("undo"), epoch: Count, groupId: Id, author: Id }),
  Schema.Struct({ type: Schema.Literal("clear"), epoch: Count }),
  Schema.Struct({ type: Schema.Literal("presence"), users: Count }),
  Schema.Struct({ type: Schema.Literal("ack"), opId: Id }),
  Schema.Struct({ type: Schema.Literal("error"), opId: Schema.String, code: Schema.String, message: Schema.String, retryable: Schema.Boolean }),
]);
export type Point = typeof PointSchema.Type;
export type Draft = typeof DraftSchema.Type;
export type Stroke = typeof StrokeSchema.Type;
export type Command = typeof CommandSchema.Type;
export type Preview = typeof PreviewSchema.Type;
export type ClientMessage = typeof ClientMessageSchema.Type;
export type ServerMessage = typeof ServerMessageSchema.Type;
