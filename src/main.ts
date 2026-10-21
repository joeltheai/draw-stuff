import "./style.css";
import { type Point } from "../shared/protocol";
import { appendPoint, type Gesture } from "./gesture";
import { CanvasSync, type DraftStorage } from "./sync";

const root = document.querySelector<HTMLDivElement>("#root")!;
const params = new URLSearchParams(location.search);
const room = (params.get("room") || "lobby").trim().slice(0, 48) || "lobby";
root.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <a class="wordmark" href="/" aria-label="Draw Stuff home"><span class="mark">d.</span><span>draw stuff</span></a>
      <div class="room-info"><span class="live-dot"></span><span>ROOM</span><strong id="room-name"></strong><span class="divider"></span><span class="people-icon">◉</span><strong id="people-count">1</strong><span>here</span></div>
      <div class="header-actions"><button class="icon-button" id="undo" title="Undo your last stroke (Ctrl/⌘ Z)" aria-label="Undo">↶</button><button class="icon-button" id="clear" title="Clear canvas" aria-label="Clear canvas">⌫</button><button class="share-button" id="share"><span>↗</span> Share room</button></div>
    </header>
    <section class="canvas-wrap" aria-label="Collaborative drawing canvas"><canvas id="canvas"></canvas><div class="hint" id="hint"><span class="hint-key">✳</span><span>Draw something together.</span><span class="hint-dot">·</span><span>Just start sketching</span></div><div class="toast" id="toast" role="status"></div><div class="canvas-meta"><span class="connection"><i id="connection-dot"></i><span id="connection-label">Connecting</span></span><span class="meta-sep">/</span><span>INFINITE FEELING, ONE CANVAS</span></div></section>
    <footer><span>MAKE A MARK. PASS IT ON.</span><span class="footer-center">A little space to draw together.</span><span>NO RULES, JUST LINES <b>✳</b></span></footer>
  </main>`;

const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const ctx = canvas.getContext("2d")!;
const roomName = document.querySelector<HTMLElement>("#room-name")!;
const peopleCount = document.querySelector<HTMLElement>("#people-count")!;
const hint = document.querySelector<HTMLElement>("#hint")!;
const toast = document.querySelector<HTMLElement>("#toast")!;
const connectionDot = document.querySelector<HTMLElement>("#connection-dot")!;
const connectionLabel = document.querySelector<HTMLElement>("#connection-label")!;
roomName.textContent = room;

let active: Gesture | null = null;
let frame = 0;
let toastTimer = 0;
let hasDrawn = false;
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
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scheduleRender();
}

function paintStroke(points: readonly Point[], width: number, height: number) {
  if (!points.length) return;
  ctx.strokeStyle = ctx.fillStyle = "#fff";
  ctx.lineWidth = 2.3;
  ctx.lineCap = ctx.lineJoin = "round";
  const first = points[0];
  ctx.beginPath();
  if (points.length === 1) {
    ctx.arc(first.x * width, first.y * height, 1.15, 0, Math.PI * 2);
    ctx.fill(); return;
  }
  ctx.moveTo(first.x * width, first.y * height);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * width, points[i].y * height);
  ctx.stroke();
}

function scheduleRender() {
  if (!frame) frame = requestAnimationFrame(render);
}
function render() {
  frame = 0;
  const { width, height } = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  const strokes = sync.strokes;
  for (const stroke of strokes) paintStroke(stroke.points, width, height);
  if (active) paintStroke(active.points, width, height);
  hint.classList.toggle("hidden", hasDrawn || strokes.length > 0 || Boolean(active));
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
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 100_000) / 100_000,
    y: Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * 100_000) / 100_000,
  };
}
canvas.addEventListener("pointerdown", event => {
  if (active || (event.button !== 0 && event.pointerType !== "touch")) return;
  canvas.setPointerCapture(event.pointerId);
  active = { id: crypto.randomUUID(), groupId: crypto.randomUUID(), points: [pointFromEvent(event)], sent: 0, pointerId: event.pointerId };
  active.sent = sync.preview(active, 0);
  hasDrawn = true;
  scheduleRender();
});
canvas.addEventListener("pointermove", event => {
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
  if (!active || event.pointerId !== active.pointerId) return;
  const finished = active;
  active = null;
  sync.commit(finished);
  scheduleRender();
}
canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);
canvas.addEventListener("lostpointercapture", finishStroke);

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
  hasDrawn = true;
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
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(canvas);
resize();
sync.start();
