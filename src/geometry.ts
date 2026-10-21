import type { Point } from "../shared/protocol";

// Every device displays the same logical surface at one CSS pixel per drawing pixel.
export const CANVAS_WIDTH = 2_000;
export const CANVAS_HEIGHT = 2_000;

export function pointFromClient(clientX: number, clientY: number, origin: { left: number; top: number }): Point {
  return {
    x: Math.round(Math.max(0, Math.min(1, (clientX - origin.left) / CANVAS_WIDTH)) * 100_000) / 100_000,
    y: Math.round(Math.max(0, Math.min(1, (clientY - origin.top) / CANVAS_HEIGHT)) * 100_000) / 100_000,
  };
}

export function canvasPosition(point: Point) {
  return { x: point.x * CANVAS_WIDTH, y: point.y * CANVAS_HEIGHT };
}
