// Usage: node sign.mjs <proved.pczt> <sk.hex> <out.pczt>
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const [,, inPath, skPath, outPath] = process.argv;
const mod = await WebAssembly.compile(readFileSync("target/wasm32-unknown-unknown/release/pczt_wasm_probe.wasm"));
console.log("imports:", WebAssembly.Module.imports(mod).length);
const inst = await WebAssembly.instantiate(mod, {});
const { memory, alloc, probe_sign } = inst.exports;
const put = (bytes) => { const p = alloc(bytes.length); new Uint8Array(memory.buffer).set(bytes, p); return p; };
const pczt = readFileSync(inPath);
const sk = Buffer.from(readFileSync(skPath, "utf8").trim(), "hex");
if (sk.length !== 32) throw new Error("sk must be 32 bytes");
const seed = randomBytes(32);
const pPczt = put(pczt), pSk = put(sk), pSeed = put(seed), pLen = alloc(8);
const t0 = performance.now();
const outPtr = probe_sign(pPczt, pczt.length, pSk, pSeed, pLen);
const t1 = performance.now();
const view = new DataView(memory.buffer);
const outLen = Number(view.getBigUint64(pLen, true)) || view.getUint32(pLen, true);
if (outPtr === 0) { console.log("probe_sign failed, code", outLen); process.exit(1); }
const signed = Buffer.from(new Uint8Array(memory.buffer, outPtr, outLen));
writeFileSync(outPath, signed);
console.log(`signed in wasm: ${pczt.length} -> ${outLen} bytes in ${(t1 - t0).toFixed(1)} ms`);
