import fs from 'node:fs';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
const raw = fs.readFileSync(process.argv[2], 'utf8').trim();
const want = process.argv[3] || '';
let addr, kind;
if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
  const k = raw.startsWith('0x') ? raw : '0x' + raw;
  addr = privateKeyToAccount(k).address; kind = 'privatekey';
} else {
  addr = mnemonicToAccount(raw).address; kind = 'mnemonic(words=' + raw.split(/\s+/).length + ')';
}
console.log('kind=' + kind);
console.log('derived=' + addr);
if (want) { console.log('expected=' + want); console.log('MATCH=' + (addr.toLowerCase() === want.toLowerCase())); }
