import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ClientMessageSchema, MAX_POINTS, type ClientMessage, type ServerMessage } from "../shared/protocol";
import { handleCommand, RoomError, RoomStore, RoomTransport, makeStore } from "./room";

interface Env {
  ROOMS: DurableObjectNamespace<DrawingRoom>;
  ASSETS: Fetcher;
}
type Session = { author: string; previewId?: string; previewGroup?: string; previewOffset?: number };

export class DrawingRoom extends DurableObject<Env> {
  private readonly store: ReturnType<typeof makeStore>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = makeStore(ctx.storage);
    Effect.runSync(this.store.initialize);
  }

  private transport = {
    broadcast: (message: ServerMessage) => Effect.sync(() => {
      const payload = JSON.stringify(message);
      for (const socket of this.ctx.getWebSockets()) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        try { socket.send(payload); } catch { socket.close(1011, "Please reconnect"); }
      }
    }),
  };

  private send(socket: WebSocket, message: ServerMessage) {
    return Effect.try({
      try: () => socket.send(JSON.stringify(message)),
      catch: () => new RoomError({ message: "Connection interrupted", retryable: true }),
    });
  }

  private present(exclude?: WebSocket) {
    return this.transport.broadcast({ type: "presence", users: this.ctx.getWebSockets().filter(s => s !== exclude && s.readyState === WebSocket.OPEN).length });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const token = new URL(request.url).searchParams.get("client");
    if (!token || !/^[a-f0-9-]{36}$/.test(token)) return new Response("Invalid client identity", { status: 400 });
    // Only the fingerprint is shared with peers; the random bearer token stays local.
    const author = await Effect.runPromise(Effect.tryPromise({
      try: async () => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), b => b.toString(16).padStart(2, "0")).join(""),
      catch: () => new RoomError({ message: "Could not identify this connection", retryable: true }),
    }));
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ author } satisfies Session);
    // No awaits during snapshot delivery: updates cannot interleave with it.
    const snapshot = Effect.gen({ self: this }, function* () {
      const epoch = yield* this.store.epoch;
      yield* this.send(server, { type: "snapshot-start", epoch, author, users: this.ctx.getWebSockets().filter(s => s.readyState === WebSocket.OPEN).length });
      for (const stroke of yield* this.store.list) yield* this.send(server, { type: "snapshot-stroke", stroke });
      yield* this.send(server, { type: "ready" });
      yield* this.present();
    });
    try { Effect.runSync(snapshot); }
    catch { server.close(1011, "Could not load this room"); }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): void {
    let message: ClientMessage | undefined;
    let opId = "";
    const program = Effect.gen({ self: this }, function* () {
      const raw = yield* Effect.try({
        try: () => {
          const text = typeof data === "string" ? data : new TextDecoder().decode(data);
          if (text.length > 180_000) throw new Error("Message too large");
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === "object" && "opId" in parsed && typeof parsed.opId === "string") opId = parsed.opId.slice(0, 80);
          return parsed;
        },
        catch: () => new RoomError({ message: "Invalid drawing update", retryable: false }),
      });
      message = yield* Schema.decodeUnknownEffect(ClientMessageSchema)(raw).pipe(
        Effect.mapError(() => new RoomError({ message: "Drawing update exceeds the supported limits", retryable: false })),
      );
      const session = socket.deserializeAttachment() as Session;
      if (message.type === "preview") {
        if (message.epoch !== (yield* this.store.epoch)) return;
        if (message.offset === 0) {
          if (session.previewId && session.previewId !== message.id) yield* this.transport.broadcast({ type: "discard-preview", id: session.previewId, author: session.author });
          session.previewId = message.id;
          session.previewGroup = message.groupId;
          session.previewOffset = 0;
        }
        if (session.previewId !== message.id || session.previewGroup !== message.groupId || session.previewOffset !== message.offset || message.offset + message.points.length > MAX_POINTS) return;
        session.previewOffset = message.offset + message.points.length;
        socket.serializeAttachment(session);
        yield* this.transport.broadcast({ ...message, author: session.author });
      } else {
        yield* handleCommand(message, session.author);
        yield* this.send(socket, { type: "ack", opId: message.opId });
      }
    }).pipe(
      Effect.provideService(RoomStore, this.store),
      Effect.provideService(RoomTransport, this.transport),
      Effect.catchTag("RoomError", error => Effect.gen({ self: this }, function* () {
        if (message?.type === "commit" && !error.retryable) yield* this.transport.broadcast({ type: "discard-preview", id: message.stroke.id, author: (socket.deserializeAttachment() as Session).author });
        yield* this.send(socket, { type: "error", opId, code: error.code || "invalid", message: error.message, retryable: error.retryable });
      })),
    );
    try { Effect.runSync(program); }
    catch { socket.close(1011, "Please reconnect to retry"); }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    // The configured compatibility date requires a reciprocal Close frame.
    socket.close([1004, 1005, 1006, 1015].includes(code) ? 1000 : code, reason);
    this.removePreview(socket);
    Effect.runSync(this.present(socket));
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "Connection interrupted");
    this.removePreview(socket);
    Effect.runSync(this.present(socket));
  }

  private removePreview(socket: WebSocket) {
    const session = socket.deserializeAttachment() as Session;
    if (session.previewId) Effect.runSync(this.transport.broadcast({ type: "discard-preview", id: session.previewId, author: session.author }));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/api\/rooms\/([^/]+)\/connect$/);
    if (match) {
      let name: string;
      try { name = decodeURIComponent(match[1]).trim().slice(0, 48) || "lobby"; }
      catch { return new Response("Bad room name", { status: 400 }); }
      return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
