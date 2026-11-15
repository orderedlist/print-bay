// Print Bay server: a typed API over the printer and the user's library, plus the web UI.
// Exported as start() so the Electron shell can run it in-process.
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { CAMERA_URL, DATA, HOST, K2_HOST, PORT, WEB_DIST } from "./config.js";
import { bus, publish } from "./events.js";
import { getJob, listModels, rates, scadParams, setScadParams } from "./jobs.js";
import { meshFor } from "./mesh.js";
import { checkModel } from "./modelchecks.js";
import { toolpathsFor } from "./gcode.js";
import * as moonraker from "./moonraker.js";
import { getQueue, print, removeEntry, startNext } from "./printing.js";
import { isSlicing, slice } from "./slice.js";
import * as agent from "./agent.js";
import * as repos from "./repos.js";

export interface StartOptions { port?: number; host?: string; quiet?: boolean }

export async function start(opts: StartOptions = {}) {
  const app = Fastify({ logger: !opts.quiet && { level: "warn" } });
  await repos.ensureLibraryRepo().catch((e) => console.warn(`Couldn't make the library a git repo: ${e.message}`));
  let status = await moonraker.getStatus();

  const poll = setInterval(async () => {
    status = await moonraker.getStatus();
    publish("status", status);
  }, 2000);
  app.addHook("onClose", async () => clearInterval(poll));

  // Files change outside the app too (CLI slices, nurb exports, hand edits):
  // tell browsers to refresh models when they do, coalescing bursts.
  let refresh: NodeJS.Timeout | null = null;
  const watchers = ["models", "jobs", "gcode"].flatMap((dir) => {
    try {
      return [fs.watch(path.join(DATA, dir), { recursive: true }, () => {
        if (refresh) clearTimeout(refresh);
        refresh = setTimeout(() => publish("models", null), 750);
      })];
    } catch { return []; }
  });
  app.addHook("onClose", async () => { for (const w of watchers) w.close(); });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.status(err.statusCode ?? 500).send({ error: err.message });
  });

  // ---- printer ----
  app.get("/api/printer", async () => ({ host: K2_HOST, camera: CAMERA_URL }));
  app.get("/api/status", async () => status);
  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/api/printer/${action}`, async () => {
      await moonraker[action]();
      return { ok: true };
    });
  }

  // ---- models and jobs ----
  app.get("/api/rates", async () => rates());
  app.get("/api/models", async () =>
    listModels().map((m) => ({ ...m, jobs: m.jobs.map((j) => ({ ...j, slicing: isSlicing(j.name) })) })));
  app.get<{ Params: { id: string } }>("/api/models/:id/mesh", async (req, reply) => {
    const file = await meshFor(req.params.id);
    return reply.type("model/stl").header("Cache-Control", "no-store").send(fs.createReadStream(file));
  });
  app.get<{ Params: { id: string } }>("/api/models/:id/print-mesh", async (req, reply) => {
    const file = await meshFor(req.params.id, { print: true });
    return reply.type("model/stl").header("Cache-Control", "no-store").send(fs.createReadStream(file));
  });
  app.get<{ Params: { id: string } }>("/api/models/:id/checks", async (req) => checkModel(req.params.id));
  app.get<{ Params: { job: string } }>("/api/jobs/:job/toolpaths", async (req, reply) => {
    const body = toolpathsFor(getJob(req.params.job).name);
    if (!body) return reply.status(404).send({ error: "Not sliced yet" });
    return reply.type("application/octet-stream").send(body);
  });
  app.get<{ Params: { job: string } }>("/api/jobs/:job/params", async (req) => scadParams(getJob(req.params.job)));
  app.put<{ Params: { job: string }; Body: { values: Record<string, string> } }>("/api/jobs/:job/params", async (req) => {
    const job = getJob(req.params.job);
    setScadParams(job, req.body.values ?? {});
    publish("models", null);
    return scadParams(getJob(job.name));
  });
  app.post<{ Params: { job: string }; Body: { perPlate?: number } | undefined }>("/api/jobs/:job/slice", async (req, reply) => {
    const job = getJob(req.params.job);
    slice(job.name, Math.max(1, Math.floor(req.body?.perPlate ?? 1))).catch(() => {}); // progress and failure arrive over SSE
    return reply.status(202).send({ ok: true });
  });

  // ---- printing ----
  app.post<{ Body: { job: string; color?: string; colors?: Record<string, string>; copies: number; perPlate?: number; startNow: boolean } }>("/api/print", async (req) =>
    print(req.body));
  app.get("/api/queue", async () => getQueue());
  app.post("/api/queue/next", async () => startNext());
  app.delete<{ Params: { id: string } }>("/api/queue/:id", async (req) => {
    removeEntry(req.params.id);
    return getQueue();
  });

  // ---- Claude agents ----
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: 15 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post<{ Body: { kind: "edit" | "new"; modelId?: string } }>("/api/agent", async (req) =>
    agent.createSession(req.body.kind === "new" ? "new" : "edit", req.body.modelId));
  app.get<{ Params: { id: string } }>("/api/agent/:id", async (req) => agent.getSession(req.params.id));
  app.get<{ Params: { id: string } }>("/api/models/:id/agent", async (req) => agent.latestFor(req.params.id));
  app.post<{ Params: { id: string }; Body: { text: string; uploads?: string[] } }>("/api/agent/:id/messages", async (req) =>
    agent.send(req.params.id, req.body.text ?? "", req.body.uploads ?? []));
  app.post<{ Params: { id: string } }>("/api/agent/:id/review", async (req) => agent.review(req.params.id));
  app.post<{ Params: { id: string } }>("/api/agent/:id/stop", async (req) => agent.stop(req.params.id));
  app.post<{ Params: { id: string } }>("/api/agent/:id/undo", async (req) => agent.undo(req.params.id));
  app.post<{ Params: { id: string }; Body: Buffer }>("/api/agent/:id/uploads", async (req) =>
    ({ name: agent.saveUpload(req.params.id, String(req.headers["content-type"]), req.body) }));
  app.get<{ Params: { id: string; name: string } }>("/api/agent/:id/uploads/:name", async (req, reply) => {
    const file = agent.uploadPath(req.params.id, req.params.name);
    const ext = path.extname(file).slice(1).replace("jpg", "jpeg").replace("svg", "svg+xml");
    // an uploaded SVG could carry script: never let it run if opened directly
    if (ext === "svg+xml") reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    return reply.type(`image/${ext}`).header("Cache-Control", "max-age=86400").send(fs.createReadStream(file));
  });

  // ---- git: the library and the app's code ----
  app.get("/api/repos", async () => repos.listRepos());
  app.post<{ Params: { id: string }; Body: { message: string } }>("/api/repos/:id/commit", async (req) =>
    repos.commit(req.params.id, req.body?.message ?? ""));
  app.post<{ Params: { id: string } }>("/api/repos/:id/push", async (req) => repos.push(req.params.id));
  app.put<{ Params: { id: string }; Body: { url: string } }>("/api/repos/:id/remote", async (req, reply) => {
    // where pushes go: only from this computer, not from anything else on the network
    if (!/^(127\.|::1$|::ffff:127\.)/.test(req.ip)) return reply.status(403).send({ error: "Change the remote from the computer running Print Bay" });
    return repos.setRemote(req.params.id, req.body?.url ?? "");
  });

  // ---- live events ----
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const send = (e: { type: string; data: unknown }) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    send({ type: "status", data: status });
    send({ type: "queue", data: getQueue() });
    bus.on("event", send);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => { bus.off("event", send); clearInterval(ping); });
  });

  // ---- web UI ----
  if (fs.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") ? reply.status(404).send({ error: "Not found" }) : reply.sendFile("index.html"));
  }

  const port = opts.port ?? PORT;
  const host = opts.host ?? HOST;
  await app.listen({ port, host });
  return { app, url: `http://localhost:${port}` };
}
