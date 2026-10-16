// Signs a watcher PCZT the way the PWA does. Used by the watcher's live test through
// ZTAB_TEST_SIGNER_CMD so the end-to-end proof runs through this package.
//   op "sign" (default when "op" is absent):
//     stdin : {"op":"sign","network":"test","spendSeedHex":"…","pcztB64":"…","recipient":"utest1…","totalZat":n,"feeZat":n}
//     stdout: {"ufvk":"…","txid":"…","signedPcztB64":"…"}
//   op "derive":
//     stdin : {"op":"derive","network":"test","spendSeedHex":"…","participantsCount":n}
//     stdout: {"ufvk":"…","addresses":["utest1…", …]}   (indices 0..n)
// Run with Node 24 (type stripping): node crypto/scripts/sign-stdin.ts < request.json
import { readFileSync } from 'node:fs';
import { CryptoError, deriveAddress, deriveTabAccount, inspectPczt, loadWasm, signPczt, type Network } from '../src/index.ts';

interface Request {
  op?: 'sign' | 'derive';
  participantsCount?: number;
  network: Network;
  spendSeedHex: string;
  pcztB64: string;
  recipient: string;
  totalZat: number;
  feeZat: number;
}

const req = JSON.parse(readFileSync(0, 'utf8')) as Request;

try {
  await loadWasm(new Uint8Array(readFileSync(new URL('../pkg/ztab_crypto_bg.wasm', import.meta.url))));
  const spendSeed = new Uint8Array(Buffer.from(req.spendSeedHex, 'hex'));
  const account = deriveTabAccount(req.network, spendSeed);
  spendSeed.fill(0);
  if (req.op === 'derive') {
    const addresses: string[] = [];
    for (let i = 0; i < (req.participantsCount ?? 0); i++) addresses.push(deriveAddress(req.network, account.ufvk, i));
    account.orchardSk.fill(0);
    process.stdout.write(JSON.stringify({ ufvk: account.ufvk, addresses }));
    process.exit(0);
  }
  const pczt = new Uint8Array(Buffer.from(req.pcztB64, 'base64url'));
  const summary = inspectPczt(req.network, pczt);
  const signed = signPczt(req.network, pczt, account.orchardSk, crypto.getRandomValues(new Uint8Array(32)), {
    recipient: req.recipient,
    totalZat: req.totalZat,
    feeZat: req.feeZat,
  });
  account.orchardSk.fill(0);
  process.stdout.write(
    JSON.stringify({ ufvk: account.ufvk, txid: summary.txid, signedPcztB64: Buffer.from(signed).toString('base64url') }),
  );
} catch (e) {
  // The watcher test shows this line; the code is what matters.
  const code = e instanceof CryptoError ? e.code : 'internal';
  process.stderr.write(`${code}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
