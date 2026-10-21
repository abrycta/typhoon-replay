// Fails the build when the Worker would not fit the free plan (3 MiB compressed). Prints the sizes for the record.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const wasm = readFileSync(new URL("../crates/server/build/index_bg.wasm", import.meta.url));
const js = readFileSync(new URL("../crates/server/build/index.js", import.meta.url));
const gz = gzipSync(Buffer.concat([wasm, js]), { level: 9 }).length;
console.log(`worker bundle: wasm ${wasm.length} B, js ${js.length} B, gzip ${gz} B (free plan limit 3145728 B)`);
if (gz >= 3 * 1024 * 1024) process.exit(1);
