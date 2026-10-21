import { MAX_POINTS, type Draft, type Point } from "../shared/protocol";

export type Gesture = { id: string; groupId: string; points: Point[]; sent: number; pointerId: number };

/** Preserve continuity and one undo group while bounding each saved segment. */
export function appendPoint(active: Gesture, point: Point): { active: Gesture; completed?: Draft } {
  const last = active.points.at(-1)!;
  if (last.x === point.x && last.y === point.y) return { active };
  if (active.points.length < MAX_POINTS) {
    active.points.push(point);
    return { active };
  }
  return {
    completed: { id: active.id, groupId: active.groupId, points: active.points },
    active: { ...active, id: crypto.randomUUID(), points: [last, point], sent: 0 },
  };
}
