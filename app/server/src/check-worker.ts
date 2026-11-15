// Runs the printability checks off the server's thread: they take seconds on a big mesh,
// and the server can't answer anything else meanwhile (see modelchecks.ts).
import { parentPort } from "node:worker_threads";
import { check, readStlParts } from "./checks.js";

parentPort!.on("message", ({ id, file, supports, pieces }: { id: number; file: string; supports: boolean; pieces: number }) => {
  try {
    const { pos, part } = readStlParts(file);
    parentPort!.postMessage({ id, report: check(pos, { supports, part, pieces }) });
  } catch (e) {
    parentPort!.postMessage({ id, error: (e as Error).message });
  }
});
