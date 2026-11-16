import { start } from "./index.js";

// Ctrl-C or kill: exit properly, so slices still running are stopped with the server (see slice.ts)
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));

const { url } = await start();
console.log(`Print Bay at ${url} (also on this machine's LAN address)`);
