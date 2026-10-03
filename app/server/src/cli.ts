import { start } from "./index.js";

const { url } = await start();
console.log(`Print Bay at ${url} (also on this machine's LAN address)`);
