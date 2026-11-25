// Print Bay server: a typed API over the printer and the user's library, plus the web UI.
// Exported as start() so the Electron shell can run it in-process.
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { DATA, HOST, normalizeHost, PORT, WEB_DIST } from "./config.js";
import { bus, publish } from "./events.js";
import { getJob, getModel, isMaterial, listJobs, listModels, rates, scadParams, setScadParams, writePlate } from "./jobs.js";
import { meshFor } from "./mesh.js";
import { isNozzle, setNozzle, getNozzle } from "./nozzle.js";
import { checkModel } from "./modelchecks.js";
import { toolpathsFor } from "./gcode.js";
import * as moonraker from "./moonraker.js";
import { forgetPrinter, getQueue, print, removeEntry, startNext } from "./printing.js";
import * as printers from "./printers.js";
import { isSlicing, slice, stopSlices } from "./slice.js";
import * as agent from "./agent.js";
import * as repos from "./repos.js";
import * as settings from "./settings.js";

export interface StartOptions {
  port?: number;
  host?: string;
  quiet?: boolean;
  /** The desktop app can restart itself (to open another library) and show a folder picker. */
  restart?: () => void;
  pickFolder?: () => Promise<string | null>;
  /** The desktop app's updater (app/desktop/updater.js): Settings shows its state. */
  updates?: Updates;
}

export interface UpdateStatus {
  version: string; // the running version
  state: "idle" | "checking" | "current" | "downloading" | "ready" | "error";
  available: string | null; // the newer version found
  percent: number | null; // of the download
  error: string | null;
  checkedAt: number | null;
}
export interface Updates {
  status(): UpdateStatus;
  onChange(fn: (s: UpdateStatus) => void): void;
  check(): void;
  install(): void;
}

export async function start(opts: StartOptions = {}) {
  const app = Fastify({ logger: !opts.quiet && { level: "warn" } });
  await repos.ensureLibraryRepo().catch((e) => console.warn(`Couldn't make the library a git repo: ${e.message}`));
  // Listen right away; a printer may be off or its name slow to resolve.
  printers.sync();
  app.addHook("onClose", async () => { printers.stop(); stopSlices(); });

  // Files change outside the app too (CLI slices, nurb exports, hand edits):
  // tell browsers to refresh models when they do, coalescing bursts.
  let refresh: NodeJS.Timeout | null = null;
  const watchers = ["models", "jobs", "plates", "gcode"].flatMap((dir) => {
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

  // ---- printers ----
  app.get("/api/printers", async () => printers.view());
  app.get("/api/printer", async () => ({ nozzle: getNozzle() })); // one nozzle setting, for slicing
  app.put<{ Body: { nozzle?: string } }>("/api/printer/nozzle", async (req, reply) => {
    const nozzle = req.body?.nozzle;
    if (!isNozzle(nozzle)) return reply.status(400).send({ error: `Unknown nozzle "${nozzle}"` });
    setNozzle(nozzle);
    publish("models", null); // every job's slice and stats are for the nozzle now set
    return { nozzle };
  });
  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post<{ Params: { id: string } }>(`/api/printers/:id/${action}`, async (req) => {
      await moonraker[action](printers.printer(req.params.id).host);
      return { ok: true };
    });
  }

  // ---- models and jobs ----
  app.get("/api/rates", async () => rates());
  app.get("/api/models", async () =>
    listModels().map((m) => ({ ...m, jobs: m.jobs.map((j) => ({ ...j, slicing: isSlicing(j.name) })) })));
  app.get<{ Params: { id: string }; Querystring: { job?: string } }>("/api/models/:id/mesh", async (req, reply) => {
    const file = await meshFor(req.params.id, { job: req.query.job });
    return reply.type("model/stl").header("Cache-Control", "no-store").send(fs.createReadStream(file));
  });
  app.get<{ Params: { id: string }; Querystring: { job?: string } }>("/api/models/:id/print-mesh", async (req, reply) => {
    const file = await meshFor(req.params.id, { print: true, job: req.query.job });
    return reply.type("model/stl").header("Cache-Control", "no-store").send(fs.createReadStream(file));
  });
  app.get<{ Params: { id: string }; Querystring: { job?: string } }>("/api/models/:id/checks", async (req) => checkModel(req.params.id, req.query.job));
  app.get<{ Params: { job: string }; Querystring: { perPlate?: string; material?: string; oneColor?: string } }>("/api/jobs/:job/toolpaths", async (req, reply) => {
    const { perPlate, material = "pla", oneColor } = req.query;
    if (!isMaterial(material)) return reply.status(400).send({ error: `Unknown material "${material}"` });
    const n = Math.max(1, Math.min(400, Math.floor(Number(perPlate ?? 1)) || 1));
    const body = toolpathsFor(getJob(req.params.job).name, n, material, oneColor === "1");
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
  app.post<{ Params: { job: string }; Body: { perPlate?: number; material?: string; oneColor?: boolean } | undefined }>("/api/jobs/:job/slice", async (req, reply) => {
    const job = getJob(req.params.job);
    const material = req.body?.material ?? "pla";
    if (!isMaterial(material)) return reply.status(400).send({ error: `Unknown material "${material}"` });
    if (job.plate && (req.body?.perPlate ?? 1) > 1) return reply.status(400).send({ error: "A plate is laid out already; print more of it as copies" });
    slice(job.name, Math.max(1, Math.floor(req.body?.perPlate ?? 1)), material, !!req.body?.oneColor && job.parts.length > 1).catch(() => {}); // progress and failure arrive over SSE
    return reply.status(202).send({ ok: true });
  });

  // ---- plates: several of a model's parts printed at once ----
  /** Counts (job -> how many) checked against the model's parts: 3MF parts only, 0-20 of each, something on it. */
  const plateCounts = (modelId: string, counts: Record<string, unknown> = {}) => {
    const parts = getModel(modelId).jobs.filter((j) => !j.plate).map((j) => getJob(j.name)).filter((j) => j.object);
    const out: Record<string, number> = {};
    for (const [job, n] of Object.entries(counts)) {
      if (!parts.some((p) => p.name === job)) throw Object.assign(new Error(`${job} isn't a part of ${modelId}`), { statusCode: 400 });
      out[job] = Math.max(0, Math.min(20, Math.floor(Number(n) || 0)));
    }
    if (!Object.values(out).some((n) => n > 0)) throw Object.assign(new Error("Put at least one part on the plate"), { statusCode: 400 });
    return out;
  };
  const plateOf = (name: string) => {
    const job = getJob(name);
    if (!job.plate) throw Object.assign(new Error(`${name} isn't a plate`), { statusCode: 400 });
    return job;
  };
  const modelOf = (job: { model: string }) => job.model.split("/")[1];
  app.post<{ Params: { id: string }; Body: { counts: Record<string, number> } }>("/api/models/:id/plates", async (req) => {
    const counts = plateCounts(req.params.id, req.body?.counts);
    const taken = new Set(listJobs().map((j) => j.name));
    let n = 1;
    while (taken.has(`${req.params.id}-plate-${n}`)) n++;
    const name = `${req.params.id}-plate-${n}`;
    writePlate(name, `Plate ${n}`, counts);
    publish("models", null);
    return { name };
  });
  app.put<{ Params: { name: string }; Body: { counts: Record<string, number> } }>("/api/plates/:name", async (req) => {
    const job = plateOf(req.params.name);
    writePlate(job.name, job.label ?? job.name, plateCounts(modelOf(job), req.body?.counts));
    publish("models", null);
    return { name: job.name };
  });
  app.delete<{ Params: { name: string } }>("/api/plates/:name", async (req) => {
    const job = plateOf(req.params.name);
    fs.rmSync(path.join(DATA, job.file));
    for (const f of fs.readdirSync(path.join(DATA, "gcode"))) // its slices, for every material and nozzle
      if (f.startsWith(`${job.name}.`) || f.startsWith(`${job.name}-`)) fs.rmSync(path.join(DATA, "gcode", f), { recursive: true, force: true });
    publish("models", null);
    return { ok: true };
  });

  // ---- printing ----
  app.post<{ Body: Parameters<typeof print>[0] }>("/api/print", async (req) =>
    print(req.body));
  app.get("/api/queue", async () => getQueue());
  app.post<{ Params: { id: string } }>("/api/printers/:id/queue/next", async (req) => startNext(req.params.id));
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

  // ---- setup and settings ----
  // Changing where the app reaches the printer, runs programs from, or pushes to: only from this computer.
  const local = (ip: string) => /^(127\.|::1$|::ffff:127\.)/.test(ip);
  const localOnly = (what: string) => Object.assign(new Error(`${what} from the computer running Print Bay`), { statusCode: 403 });
  const desktop = { restart: !!opts.restart, pickFolder: !!opts.pickFolder };
  app.get("/api/settings", async () => ({ ...settings.view(), desktop }));
  app.put<{ Body: settings.SettingsUpdate }>("/api/settings", async (req) => {
    if (!local(req.ip)) throw localOnly("Change settings");
    return { ...settings.update(req.body ?? {}), desktop };
  });
  // a changed printer shows at once: its polling restarts at the new address
  app.post<{ Body: settings.PrinterInput }>("/api/settings/printers", async (req) => {
    if (!local(req.ip)) throw localOnly("Add a printer");
    const p = settings.addPrinter(req.body ?? {});
    printers.sync();
    return p;
  });
  app.put<{ Params: { id: string }; Body: settings.PrinterInput }>("/api/settings/printers/:id", async (req) => {
    if (!local(req.ip)) throw localOnly("Change a printer");
    const p = settings.updatePrinter(req.params.id, req.body ?? {});
    printers.sync();
    return p;
  });
  app.delete<{ Params: { id: string } }>("/api/settings/printers/:id", async (req) => {
    if (!local(req.ip)) throw localOnly("Remove a printer");
    settings.removePrinter(req.params.id);
    forgetPrinter(req.params.id);
    printers.sync();
    return { ok: true };
  });
  app.post("/api/settings/scan-printers", async () => {
    const found = await moonraker.scanForPrinters();
    const moved = settings.applyScan(found);
    if (moved.length) printers.sync(); // poll them at their new addresses
    return { found, moved };
  });
  app.post<{ Body: { host: string } }>("/api/settings/test-printer", async (req) => {
    const host = normalizeHost(req.body?.host ?? "");
    return { host, ...(await moonraker.probe(host)) };
  });
  app.post("/api/library/pick", async (req) => {
    if (!local(req.ip)) throw localOnly("Choose a folder");
    if (!opts.pickFolder) throw Object.assign(new Error("Type the folder's path instead"), { statusCode: 409 });
    return { path: await opts.pickFolder() };
  });
  app.post("/api/restart", async (req, reply) => {
    if (!local(req.ip)) throw localOnly("Restart Print Bay");
    if (!opts.restart) return reply.status(409).send({ error: "Restart the server yourself (npm start) to open the other library." });
    setTimeout(opts.restart, 300); // answer first
    return { ok: true };
  });
  app.post<{ Body: { url: string } }>("/api/library/start-from-remote", async (req) => {
    if (!local(req.ip)) throw localOnly("Change the library");
    const result = await repos.startFromRemote(req.body?.url ?? "", settings.view().library.fresh);
    publish("models", null);
    return result;
  });

  // ---- git: the library and the app's code ----
  app.get<{ Querystring: { fetch?: string } }>("/api/repos", async (req) => {
    if (req.query.fetch) await repos.fetchAll();
    return repos.listRepos();
  });
  app.post<{ Params: { id: string } }>("/api/repos/:id/pull", async (req) => {
    const result = await repos.pull(req.params.id);
    if (result.pulled) publish("models", null);
    return result;
  });
  app.post<{ Params: { id: string }; Body: { message: string } }>("/api/repos/:id/commit", async (req) =>
    repos.commit(req.params.id, req.body?.message ?? ""));
  app.post<{ Params: { id: string } }>("/api/repos/:id/push", async (req) => repos.push(req.params.id));
  app.put<{ Params: { id: string }; Body: { url: string } }>("/api/repos/:id/remote", async (req, reply) => {
    // where pushes go: only from this computer, not from anything else on the network
    if (!local(req.ip)) return reply.status(403).send({ error: "Change the remote from the computer running Print Bay" });
    return repos.setRemote(req.params.id, req.body?.url ?? "");
  });

  // ---- app updates (desktop only): the state comes over /api/events as "update" ----
  opts.updates?.onChange((s) => publish("update", s));
  app.post("/api/update/check", async (req, reply) => {
    if (!opts.updates) return reply.status(409).send({ error: "Only the desktop app updates itself" });
    if (!local(req.ip)) throw localOnly("Check for updates");
    opts.updates.check();
    return opts.updates.status();
  });
  app.post("/api/update/install", async (req, reply) => {
    if (!opts.updates) return reply.status(409).send({ error: "Only the desktop app updates itself" });
    if (!local(req.ip)) throw localOnly("Restart to update");
    setTimeout(() => opts.updates!.install(), 300); // answer first
    return { ok: true };
  });

  // ---- live events ----
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const send = (e: { type: string; data: unknown }) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    send({ type: "printers", data: printers.view() });
    send({ type: "queue", data: getQueue() });
    send({ type: "update", data: opts.updates?.status() ?? null });
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
  try {
    await app.listen({ port, host });
  } catch (err) {
    await app.close(); // stops the status polling and file watchers before the caller retries
    throw err;
  }
  return { app, url: `http://localhost:${port}` };
}
