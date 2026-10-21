import assert from "node:assert/strict";
import { test } from "node:test";
import { CANVAS_WIDTH, CANVAS_HEIGHT, canvasPosition, pointFromClient } from "../src/geometry";

test("a phone-drawn circle stays circular at every desktop and mobile scroll position", () => {
  const radius = 80;
  // The phone is scrolled into the board; its canvas origin is outside the viewport.
  const phoneOrigin = { left: -600, top: -400 };
  const center = { x: 760, y: 650 };
  const circle = Array.from({ length: 64 }, (_, i) => {
    const angle = i / 64 * Math.PI * 2;
    return pointFromClient(center.x + radius * Math.cos(angle) + phoneOrigin.left, center.y + radius * Math.sin(angle) + phoneOrigin.top, phoneOrigin);
  });
  for (const origin of [phoneOrigin, { left: 0, top: 48 }, { left: -1200, top: -1000 }]) {
    const positions = circle.map(canvasPosition);
    const width = Math.max(...positions.map(p => p.x)) - Math.min(...positions.map(p => p.x));
    const height = Math.max(...positions.map(p => p.y)) - Math.min(...positions.map(p => p.y));
    assert.equal(width, radius * 2);
    assert.equal(height, radius * 2);
    for (let i = 0; i < positions.length; i++) {
      const position = positions[i];
      const recaptured = pointFromClient(position.x + origin.left, position.y + origin.top, origin);
      assert.deepEqual(recaptured, circle[i], "scrolling changes only the visible origin, never the stored geometry");
    }
  }
});

test("scrolling in either axis maps a pointer to the same board location", () => {
  const desktop = pointFromClient(300, 448, { left: 0, top: 48 });
  const scrolledPhone = pointFromClient(100, 200, { left: -200, top: -200 });
  assert.deepEqual(scrolledPhone, desktop);
  assert.deepEqual(canvasPosition(desktop), { x: 300, y: 400 });
});

test("captured pointer movement clamps at the fixed canvas edges", () => {
  assert.deepEqual(pointFromClient(-100, -100, { left: 0, top: 0 }), { x: 0, y: 0 });
  assert.deepEqual(pointFromClient(CANVAS_WIDTH + 100, CANVAS_HEIGHT + 100, { left: 0, top: 0 }), { x: 1, y: 1 });
  assert.deepEqual(canvasPosition({ x: 1, y: 1 }), { x: CANVAS_WIDTH, y: CANVAS_HEIGHT });
});
