import { EventEmitter } from "node:events";

/** Everything pushed to browsers over SSE: `status`, `queue`, `slice`, `models`. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function publish(type: string, data: unknown) {
  bus.emit("event", { type, data });
}
