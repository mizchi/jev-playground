// Regenerates generated/squares.json from the source of truth below.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const out = {};
for (let i = 1; i <= 8; i += 1) out[i] = i * i;
mkdirSync(resolve(import.meta.dirname, "../generated"), { recursive: true });
writeFileSync(resolve(import.meta.dirname, "../generated/squares.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote generated/squares.json");
