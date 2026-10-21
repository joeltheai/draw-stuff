import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandSchema, ServerMessageSchema, MAX_PREVIEW_POINTS,
  type Command, type Draft, type Preview, type ServerMessage, type Stroke,
} from "../shared/protocol";

class DraftStorageError extends Data.TaggedError("DraftStorageError")<{ message: string }> {}
export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const QueueSchema = Schema.Array(CommandSchema);

export const makeDraftStore = (storage: DraftStorage, key: string) => ({
  load: Effect.gen(function* () {
    const value = yield* Effect.try({ try: () => storage.getItem(key), catch: () => new DraftStorageError({ message: "Browser storage is unavailable. Keep this tab open until your drawings sync." }) });
    if (!value) return [] as Command[];
    const parsed = yield* Effect.try({ try: () => JSON.parse(value) as unknown, catch: () => new DraftStorageError({ message: "Saved drawings could not be loaded. The original saved data has been kept." }) });
    return [...(yield* Schema.decodeUnknownEffect(QueueSchema)(parsed).pipe(Effect.mapError(() => new DraftStorageError({ message: "Saved drawings use an unsupported format. The original saved data has been kept." }))))];
  }),
  save: (queue: readonly Command[]) => Effect.try({
    try: () => storage.setItem(key, JSON.stringify(queue)),
    catch: () => new DraftStorageError({ message: "Browser storage is full. Keep this tab open until your drawings sync." }),
  }),
});
class DraftStore extends Context.Service<DraftStore, ReturnType<typeof makeDraftStore>>()("draw/DraftStore") {}

type Callbacks = { changed(): void; notice(message: string): void };
type Options = {
  room: string; token: string; storage: DraftStorage; url: string;
  callbacks: Callbacks;
  socket?: (url: string) => WebSocket;
};

/** Server state plus a durable local outbox. Only acknowledgements retire commands. */
export class CanvasSync {
  author = "";
  epoch = 0;
  ready = false;
  users = 0;
  connectionVersion = 0;
  blocked = false;
  pending: Command[] = [];
  readonly confirmed = new Map<string, Stroke>();
  readonly previews = new Map<string, Stroke>();
  private socket: WebSocket | null = null;
  private inFlight: string | null = null;
  private localPreviewId: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = false;
  private storageHealthy = true;
  private storageWriteFailed = false;
  private readonly store: ReturnType<typeof makeDraftStore>;

  constructor(private readonly options: Options) {
    this.store = makeDraftStore(options.storage, `draw-stuff:outbox:v2:${options.room}`);
    this.pending = Effect.runSync(Effect.match(this.store.load, {
      onSuccess: value => value,
      onFailure: error => { this.storageHealthy = false; options.callbacks.notice(error.message); return []; },
    }));
  }

  get strokes(): Stroke[] {
    const visible = new Map(this.confirmed);
    for (const command of this.pending) {
      if (command.type === "commit") visible.set(command.stroke.id, { ...command.stroke, author: this.author });
      else if (command.type === "undo") {
        for (const [id, stroke] of visible) if (stroke.groupId === command.groupId && stroke.author === this.author) visible.delete(id);
      } else visible.clear();
    }
    for (const [id, stroke] of this.previews) if (!visible.has(id)) visible.set(id, stroke);
    return [...visible.values()];
  }

  get status(): string {
    if (!this.ready) return this.pending.length ? (this.storageWriteFailed || !this.storageHealthy ? "Offline · keep this tab open" : "Offline · drawings saved here") : "Reconnecting";
    if (this.blocked) return "Drawing waiting to sync";
    return this.pending.length ? "Saving drawing…" : "Connected";
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.ackTimer);
    this.socket?.close(1000, "Leaving room");
  }

  private changed() { this.options.callbacks.changed(); }
  private persist() {
    if (!this.storageHealthy) return;
    Effect.runSync(Effect.gen({ self: this }, function* () {
      const store = yield* DraftStore;
      yield* store.save(this.pending);
    }).pipe(
      Effect.provideService(DraftStore, this.store),
      Effect.match({
        onSuccess: () => { this.storageWriteFailed = false; },
        onFailure: error => { this.storageWriteFailed = true; this.options.callbacks.notice(error.message); },
      }),
    ));
  }

  commit(stroke: Draft) {
    if (this.localPreviewId === stroke.id) this.localPreviewId = null;
    this.pending.push({ type: "commit", opId: crypto.randomUUID(), epoch: this.epoch, stroke });
    this.previews.delete(stroke.id);
    this.persist();
    this.changed();
    this.flush();
  }

  undo() {
    const own = this.strokes.filter(stroke => stroke.author === this.author);
    const last = own.at(-1);
    if (!last) return;
    // Keep any transmitted command until its ack; remove the rest of the gesture locally.
    this.pending = this.pending.filter(command => command.opId === this.inFlight || command.type !== "commit" || command.stroke.groupId !== last.groupId);
    this.pending.splice(this.inFlight ? 1 : 0, 0, { type: "undo", opId: crypto.randomUUID(), epoch: this.epoch, groupId: last.groupId });
    for (const [id, stroke] of this.previews) if (stroke.groupId === last.groupId && stroke.author === this.author) this.previews.delete(id);
    this.blocked = false;
    this.persist(); this.changed(); this.flush();
  }

  clear() {
    // Clearing is intentional; retain only a command already transmitted to the server.
    this.pending = this.pending.filter(command => command.opId === this.inFlight);
    this.pending.push({ type: "clear", opId: crypto.randomUUID(), epoch: this.epoch });
    this.previews.clear();
    this.blocked = false;
    this.persist(); this.changed(); this.flush();
  }

  preview(stroke: Draft, offset: number): number {
    if (!this.ready || !this.socket || this.socket.bufferedAmount > 64_000) return offset;
    this.localPreviewId = stroke.id;
    while (offset < stroke.points.length) {
      const points = stroke.points.slice(offset, offset + MAX_PREVIEW_POINTS);
      const message: Preview = { type: "preview", epoch: this.epoch, id: stroke.id, groupId: stroke.groupId, offset, points };
      try { this.socket.send(JSON.stringify(message)); }
      catch { this.socket.close(); return offset; }
      offset += points.length;
    }
    return offset;
  }

  private connect() {
    if (this.stopped) return;
    const url = new URL(`/api/rooms/${encodeURIComponent(this.options.room)}/connect`, this.options.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("client", this.options.token);
    const socket = (this.options.socket ?? (url => new WebSocket(url)))(url.toString());
    this.socket = socket;
    this.ready = false;
    socket.addEventListener("message", event => {
      if (this.socket !== socket) return;
      const decoded = Effect.gen(function* () {
        const json = yield* Effect.try(() => JSON.parse(String(event.data)) as unknown);
        return yield* Schema.decodeUnknownEffect(ServerMessageSchema)(json);
      });
      Effect.runSync(Effect.match(decoded, {
        onFailure: () => { this.options.callbacks.notice("The room sent an unreadable update. Reconnecting…"); socket.close(1002, "Invalid room update"); },
        onSuccess: message => this.receive(message),
      }));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.ready = false;
      this.inFlight = null;
      clearTimeout(this.ackTimer);
      this.previews.clear();
      this.changed();
      if (!this.stopped) this.retryTimer = setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** Math.min(this.attempt++, 5)));
    });
    socket.addEventListener("error", () => socket.close());
    this.changed();
  }

  private flush() {
    if (!this.ready || this.inFlight || this.blocked || !this.pending.length || this.socket?.readyState !== WebSocket.OPEN) return;
    const command = this.pending[0];
    this.inFlight = command.opId;
    try {
      this.socket.send(JSON.stringify(command));
      this.ackTimer = setTimeout(() => this.socket?.close(4000, "Retrying unacknowledged drawing"), 8_000);
    } catch { this.socket.close(); }
  }

  private receive(message: ServerMessage) {
    if (message.type === "snapshot-start") {
      this.author = message.author;
      this.epoch = message.epoch;
      this.users = message.users;
      this.confirmed.clear(); this.previews.clear();
    } else if (message.type === "snapshot-stroke") this.confirmed.set(message.stroke.id, message.stroke);
    else if (message.type === "ready") {
      this.ready = true; this.attempt = 0; this.blocked = false; this.connectionVersion++;
      // Unsaved drawings survive a room reset. Stale destructive commands are not replayed.
      this.pending = this.pending.filter(command => command.type === "commit" || command.epoch === this.epoch).map(command => ({ ...command, epoch: this.epoch }));
      this.persist(); this.flush();
    } else if (message.type === "stroke" && message.epoch === this.epoch) {
      this.confirmed.set(message.stroke.id, message.stroke);
      this.previews.delete(message.stroke.id);
    } else if (message.type === "preview" && message.epoch === this.epoch && message.id !== this.localPreviewId) {
      const previous = this.previews.get(message.id);
      if (message.offset === 0 || (previous && previous.points.length === message.offset)) {
        this.previews.set(message.id, { id: message.id, groupId: message.groupId, author: message.author, points: [...(message.offset === 0 ? [] : previous!.points), ...message.points] });
      }
    } else if (message.type === "discard-preview") this.previews.delete(message.id);
    else if (message.type === "presence") this.users = message.users;
    else if (message.type === "undo" && message.epoch === this.epoch) {
      for (const [id, stroke] of this.confirmed) if (stroke.groupId === message.groupId && stroke.author === message.author) this.confirmed.delete(id);
      for (const [id, stroke] of this.previews) if (stroke.groupId === message.groupId && stroke.author === message.author) this.previews.delete(id);
      this.blocked = false; this.flush();
    } else if (message.type === "clear") {
      this.epoch = message.epoch;
      this.confirmed.clear(); this.previews.clear();
      this.pending = this.pending.filter(command => command.type === "commit" || command.opId === this.inFlight).map(command => command.type === "commit" ? { ...command, epoch: this.epoch } : command);
      this.blocked = false; this.persist(); this.flush();
    } else if (message.type === "ack" && message.opId === this.inFlight) {
      this.pending = this.pending.filter(command => command.opId !== message.opId);
      this.inFlight = null; clearTimeout(this.ackTimer);
      this.persist(); this.flush();
    } else if (message.type === "error") {
      this.options.callbacks.notice(`${message.message} Your unsaved drawing is kept on this device.`);
      if (message.opId === this.inFlight) {
        this.inFlight = null; clearTimeout(this.ackTimer);
        if (message.retryable || message.code === "stale") this.socket?.close(4000, "Retrying drawing");
        else {
          const failed = this.pending.find(command => command.opId === message.opId);
          const intentionallyCancelled = failed?.type === "commit" && this.pending.some(command => command.type === "clear" || (command.type === "undo" && command.groupId === failed.stroke.groupId));
          if (intentionallyCancelled) {
            this.pending = this.pending.filter(command => command.opId !== message.opId);
            this.persist(); this.flush();
          } else this.blocked = true;
        }
      }
    }
    this.changed();
  }
}
