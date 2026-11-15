// node app/server/dist/check-cli.js <model-id>   (or scripts/check <model-id>)
// Printability checks for a model as it will be sliced, for people and agents.
import { checkModel } from "./modelchecks.js";

const id = process.argv[2];
if (!id) {
  console.error("usage: node app/server/dist/check-cli.js <model-id>   (a folder name under models/)");
  process.exit(2);
}
try {
  const r = await checkModel(id);
  console.log(`${id}: ${r.size.join(" x ")} mm as printed, ${r.triangles} triangles, supports ${r.supports ? "on" : "off"}`);
  if (!r.findings.length) console.log("No findings.");
  for (const f of r.findings) {
    console.log(`${f.severity.toUpperCase().padEnd(4)} ${f.rule}: ${f.message}`);
    console.log(`     ${f.detail} @ (${f.at.map((v) => v.toFixed(1)).join(", ")}) mm, bed-centered`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
