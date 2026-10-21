import "./style.css";
import { type Point } from "../shared/protocol";
import { appendPoint, type Gesture } from "./gesture";
import { CanvasSync, type DraftStorage } from "./sync";
import { CANVAS_WIDTH, CANVAS_HEIGHT, canvasPosition, pointFromClient } from "./geometry";

const root = document.querySelector<HTMLDivElement>("#root")!;
const params = new URLSearchParams(location.search);
const room = (params.get("room") || "lobby").trim().slice(0, 48) || "lobby";
root.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <span id="room-name" class="room-name"></span>
      <div class="tools" role="group" aria-label="Canvas tools">
        <button id="draw" aria-pressed="true" title="Draw on the canvas">Draw</button>
        <button id="move" aria-pressed="false" title="Scroll or drag to move around the canvas">Move</button>
      </div>
      <div class="header-actions">
        <button id="undo" title="Undo your last drawing (Ctrl/⌘ Z)">Undo</button>
        <button id="clear" title="Clear the shared canvas">Clear</button>
        <button id="share">Share</button>
      </div>
    </header>
    <div id="viewport" class="canvas-viewport" tabindex="0" aria-label="Drawing area. Choose Move to scroll, or Draw to doodle.">
      <canvas id="canvas" aria-label="Shared 2000 by 2000 pixel drawing canvas"></canvas>
    </div>
    <div class="connection" aria-live="polite"><i id="connection-dot"></i><span id="connection-label">Connecting</span><span aria-hidden="true">·</span><span><span id="people-count">0</span> here</span></div>
    <div class="toast" id="toast" role="status"></div>
  </main>`;
root.style.setProperty("--canvas-width", `${CANVAS_WIDTH}px`);
root.style.setProperty("--canvas-height", `${CANVAS_HEIGHT}px`);

const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const ctx = canvas.getContext("2d")!;
const roomName = document.querySelector<HTMLElement>("#room-name")!;
const peopleCount = document.querySelector<HTMLElement>("#people-count")!;
const viewport = document.querySelector<HTMLDivElement>("#viewport")!;
const drawButton = document.querySelector<HTMLButtonElement>("#draw")!;
const moveButton = document.querySelector<HTMLButtonElement>("#move")!;
const toast = document.querySelector<HTMLElement>("#toast")!;
const connectionDot = document.querySelector<HTMLElement>("#connection-dot")!;
const connectionLabel = document.querySelector<HTMLElement>("#connection-label")!;
roomName.textContent = room;
roomName.title = `Room: ${room}`;

let active: Gesture | null = null;
let frame = 0;
let toastTimer = 0;
let mode: "draw" | "move" = "draw";
let pan: { pointerId: number; x: number; y: number; left: number; top: number } | null = null;
let storage: DraftStorage;
try { storage = sessionStorage; } catch { storage = { getItem: () => null, setItem: () => { throw new Error("Storage unavailable"); } }; }
let token: string;
try {
  token = localStorage.getItem("draw-stuff:identity:v2") || crypto.randomUUID();
  localStorage.setItem("draw-stuff:identity:v2", token);
} catch {
  token = crypto.randomUUID();
  try {
    token = storage.getItem("draw-stuff:identity:v2") || token;
    storage.setItem("draw-stuff:identity:v2", token);
  } catch { /* drafts remain in memory */ }
}
const sync = new CanvasSync({
  room, token, storage, url: location.href,
  callbacks: { changed: scheduleRender, notice: notify },
});

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Only the backing resolution changes with pixel density, never the drawing size.
  const width = Math.round(CANVAS_WIDTH * dpr);
  const height = Math.round(CANVAS_HEIGHT * dpr);
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scheduleRender();
}

function paintStroke(points: readonly Point[]) {
  if (!points.length) return;
  ctx.strokeStyle = ctx.fillStyle = "#fff";
  ctx.lineWidth = 2.3;
  ctx.lineCap = ctx.lineJoin = "round";
  const first = canvasPosition(points[0]);
  ctx.beginPath();
  if (points.length === 1) {
    ctx.arc(first.x, first.y, 1.15, 0, Math.PI * 2);
    ctx.fill(); return;
  }
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const point = canvasPosition(points[i]);
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
}

function scheduleRender() {
  if (!frame) frame = requestAnimationFrame(render);
}
function render() {
  frame = 0;
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  const strokes = sync.strokes;
  for (const stroke of strokes) paintStroke(stroke.points);
  if (active) paintStroke(active.points);
  peopleCount.textContent = String(sync.users);
  connectionDot.className = sync.ready && !sync.pending.length ? "online" : "offline";
  connectionLabel.textContent = sync.status;
  document.querySelector<HTMLButtonElement>("#undo")!.disabled = !strokes.some(stroke => stroke.author === sync.author);
}
function notify(message: string) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 6_000);
}

function pointFromEvent(event: PointerEvent): Point {
  return pointFromClient(event.clientX, event.clientY, canvas.getBoundingClientRect());
}
canvas.addEventListener("pointerdown", event => {
  if (active || pan || (event.button !== 0 && event.pointerType !== "touch")) return;
  if (mode === "move") {
    // Touch uses native momentum scrolling; mouse/pen can drag the viewport.
    if (event.pointerType !== "touch") {
      canvas.setPointerCapture(event.pointerId);
      pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.classList.add("dragging");
    }
    return;
  }
  canvas.setPointerCapture(event.pointerId);
  active = { id: crypto.randomUUID(), groupId: crypto.randomUUID(), points: [pointFromEvent(event)], sent: 0, pointerId: event.pointerId };
  active.sent = sync.preview(active, 0);
  scheduleRender();
});
canvas.addEventListener("pointermove", event => {
  if (pan?.pointerId === event.pointerId) {
    viewport.scrollLeft = pan.left + pan.x - event.clientX;
    viewport.scrollTop = pan.top + pan.y - event.clientY;
    return;
  }
  if (!active || event.pointerId !== active.pointerId) return;
  const result = appendPoint(active, pointFromEvent(event));
  active = result.active;
  if (result.completed) sync.commit(result.completed);
  scheduleRender();
});
let previewConnection = 0;
function sendPreview() {
  if (previewConnection !== sync.connectionVersion) {
    if (active) active.sent = 0;
    previewConnection = sync.connectionVersion;
  }
  if (active) active.sent = sync.preview(active, active.sent);
}
let previewTimer = window.setInterval(sendPreview, 60);
function finishStroke(event: PointerEvent) {
  if (pan?.pointerId === event.pointerId) {
    pan = null;
    viewport.classList.remove("dragging");
  }
  if (!active || event.pointerId !== active.pointerId) return;
  const finished = active;
  active = null;
  sync.commit(finished);
  scheduleRender();
}
canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);
canvas.addEventListener("lostpointercapture", finishStroke);

function setMode(next: "draw" | "move") {
  if (active) { sync.commit(active); active = null; }
  mode = next;
  viewport.classList.toggle("move-mode", mode === "move");
  drawButton.setAttribute("aria-pressed", String(mode === "draw"));
  moveButton.setAttribute("aria-pressed", String(mode === "move"));
  scheduleRender();
}
drawButton.addEventListener("click", () => setMode("draw"));
moveButton.addEventListener("click", () => setMode("move"));

document.querySelector("#undo")!.addEventListener("click", () => sync.undo());
window.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
    event.preventDefault();
    if (!active) sync.undo();
  }
});
document.querySelector("#clear")!.addEventListener("click", () => {
  active = null;
  sync.clear();
});
document.querySelector("#share")!.addEventListener("click", async () => {
  const url = new URL(location.href);
  url.searchParams.set("room", room);
  try { await navigator.clipboard.writeText(url.toString()); notify("Room link copied"); }
  catch { window.prompt("Copy this room link", url.toString()); }
});
window.addEventListener("beforeunload", event => {
  if (active || sync.pending.length) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("pagehide", () => {
  if (active) { sync.commit(active); active = null; }
  clearInterval(previewTimer);
  sync.stop();
});
window.addEventListener("pageshow", event => {
  if (event.persisted) { previewTimer = window.setInterval(sendPreview, 60); sync.start(); }
});
window.addEventListener("resize", resize);
resize();
sync.start();
