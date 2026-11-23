// Port of Sec-MS-GEC v2 token generation from rany2/edge-tts (src/edge_tts/drm.py).

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
export const CHROMIUM_FULL_VERSION = "143.0.3650.75";
export const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;

const WIN_EPOCH = 11644473600;
const S_TO_NS = 1e9;
const M = 0xffffffffn;

const SHA256_INITIAL: readonly bigint[] = [
  0x6a09e667n,
  0xbb67ae85n,
  0x3c6ef372n,
  0xa54ff53an,
  0x510e527fn,
  0x9b05688cn,
  0x1f83d9abn,
  0x5be0cd19n,
];

const SHA256_STATE: readonly bigint[] = [
  0xfd9fbea2n,
  0x91243ce7n,
  0xbe499094n,
  0xcd2e1e0an,
  0x6c006f49n,
  0x04bd35abn,
  0xfeb0a7e4n,
  0x03effbd2n,
];

const SHA256_SCHEDULE: readonly bigint[] = [
  0xeb24bf9en,
  0x1558691fn,
  0xa0c09ee2n,
  0x0cfa32ban,
  0xa622ee8cn,
  0xd1dd9491n,
  0xc0dd25a0n,
  0xf9e70ab6n,
  0xf0c31573n,
  0x7058ce4en,
  0x7188e606n,
  0x00e5ab33n,
  0xd258b060n,
  0x72766564n,
];

const SHA256_ROUND_CONSTANTS: readonly bigint[] = [
  0x428a2f98n, 0x71374491n, 0xb5c0fbcfn, 0xe9b5dba5n, 0x3956c25bn, 0x59f111f1n, 0x923f82a4n, 0xab1c5ed5n,
  0xd807aa98n, 0x12835b01n, 0x243185ben, 0x550c7dc3n, 0x72be5d74n, 0x80deb1fen, 0x9bdc06a7n, 0xc19bf174n,
  0xe49b69c1n, 0xefbe4786n, 0x0fc19dc6n, 0x240ca1ccn, 0x2de92c6fn, 0x4a7484aan, 0x5cb0a9dcn, 0x76f988dan,
  0x983e5152n, 0xa831c66dn, 0xb00327c8n, 0xbf597fc7n, 0xc6e00bf3n, 0xd5a79147n, 0x06ca6351n, 0x14292967n,
  0x27b70a85n, 0x2e1b2138n, 0x4d2c6dfcn, 0x53380d13n, 0x650a7354n, 0x766a0abbn, 0x81c2c92en, 0x92722c85n,
  0xa2bfe8a1n, 0xa81a664bn, 0xc24b8b70n, 0xc76c51a3n, 0xd192e819n, 0xd6990624n, 0xf40e3585n, 0x106aa070n,
  0x19a4c116n, 0x1e376c08n, 0x2748774cn, 0x34b0bcb5n, 0x391c0cb3n, 0x4ed8aa4an, 0x5b9cca4fn, 0x682e6ff3n,
  0x748f82een, 0x78a5636fn, 0x84c87814n, 0x8cc70208n, 0x90befffan, 0xa4506cebn, 0xbef9a3f7n, 0xc67178f2n,
];

const SHA256_ADJUSTMENT = 0xc9dc06a7n;
const SHA256_BLOCK_CONSTANTS: readonly bigint[] = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80n;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0n;

const CS64_COEFFICIENTS: readonly [bigint, bigint][] = [
  [0xe82e91b1n, 0xb32700d0n],
  [0x44de24c6n, 0x88dff51dn],
  [0x3beb65bcn, 0x29514038n],
  [0xc89c5933n, 0xb328cbdfn],
  [0x8d1ec211n, 0xd405b4d5n],
  [0x314ef5d5n, 0x26e55f3cn],
  [0xe92491b1n, 0x607801c6n],
  [0xf0a5b9d5n, 0x82b2c1fbn],
  [0x06064cf3n, 0xfa51a3dan],
  [0xda79fa60n, 0x207cc464n],
  [0xbed20560n, 0x3c3c74f3n],
  [0x89f9c9f8n, 0xd2d14b61n],
  [0x35fa38c6n, 0xbb04a2c1n],
  [0xcb49e3c6n, 0xc5626167n],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJUSTMENT0 = 0xf2f90b1an;
const CS64_ADJUSTMENT1 = 0x0b1a0000n;

function rol16(value: bigint): bigint {
  const v = value & M;
  return ((v << 16n) | (v >> 16n)) & M;
}

function rotr32(value: bigint, bits: number): bigint {
  const v = value & M;
  const b = BigInt(bits);
  return ((v >> b) | (v << (32n - b))) & M;
}

function wordsLe4Even(data: Uint8Array): bigint[] {
  const padLen = (4 - (data.length % 4)) % 4;
  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  if (padded.length === 0) return [];
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const words: bigint[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push(BigInt(view.getUint32(i, true)));
  }
  if (words.length % 2 === 1) {
    words.push(0n);
  }
  return words;
}

function sigma0(value: bigint): bigint {
  return ((value >> 7n) ^ (value << 25n) ^ (value >> 18n) ^ (value << 14n) ^ (value >> 3n)) & M;
}

function sigma1(value: bigint): bigint {
  return ((value >> 17n) ^ (value << 15n) ^ (value >> 19n) ^ (value << 13n) ^ (value >> 10n)) & M;
}

function sha256Rounds(state: readonly bigint[], words: readonly bigint[], firstRound: number = 0): bigint[] {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    const ch = g ^ (e & (f ^ g));
    const t1 = h + s1 + ch + constants[i] + words[i];
    const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    const maj = (a & b) | (c & (a | b));
    const t2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = (d + t1) & M;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) & M;
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSha256Schedule(words: bigint[], firstWord: number = 16): void {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2];
    const y = words[i - 15];
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
    words.push((s1 + words[i - 7] + s0 + words[i - 16]) & M);
  }
}

let cachedInitKey: string | null = null;
let cachedInitState: bigint[] | null = null;

function sha256Init(data7: Uint8Array): bigint[] {
  const key = Array.from(data7).join(",");
  if (cachedInitKey === key && cachedInitState) {
    return cachedInitState;
  }
  const words: bigint[] = new Array(14).fill(0n);
  words.push(BigInt((data7[0] << 16) | (data7[1] << 8) | data7[2]));
  words.push(BigInt(((data7[3] << 24) | (data7[4] << 16) | (data7[5] << 8) | data7[6]) >>> 0));

  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      const s1 = sigma1(words[i - 2]);
      value += i === 16 ? (s1 ^ SHA256_SIGMA1_ADJUSTMENT) : s1;
    }
    if (i - 7 >= 14) {
      value += words[i - 7];
    }
    if (i - 15 >= 14) {
      const s0 = sigma0(words[i - 15]);
      value += i === 29 ? (s0 ^ SHA256_SIGMA0_ADJUSTMENT) : s0;
    }
    words.push(value & M);
  }

  words.push(
    (
      sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]
    ) & M
  );

  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  const result = SHA256_INITIAL.map((x, idx) => (x + working[idx]) & M);
  cachedInitKey = key;
  cachedInitState = result;
  return result;
}

function sha256Digest(data: Uint8Array): Uint8Array {
  if (data.length < 7) {
    throw new Error("Token salt must contain at least seven bytes");
  }
  const length = 57 + data.length;
  const zeroPad = ((55 - length) % 64 + 64) % 64;
  const tail = data.subarray(7);
  const padded = new Uint8Array(tail.length + 1 + zeroPad + 8);
  padded.set(tail, 0);
  padded[tail.length] = 0x80;
  const padView = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  padView.setBigUint64(padded.length - 8, BigInt(length) * 8n, false);

  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: bigint[] = [];
    for (let i = 0; i < 16; i++) {
      words.push(BigInt(padView.getUint32(offset + i * 4, false)));
    }
    expandSha256Schedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, idx) => (x + working[idx]) & M);
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, Number(state[i] & M), false);
  }
  return out;
}

function cs64Digest(data: Uint8Array, digest: Uint8Array): [bigint, bigint] {
  const digestView = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const keyA = BigInt(digestView.getUint32(0, true)) | 1n;
  const keyB = BigInt(digestView.getUint32(4, true)) | 1n;
  const factorA = (keyA * CS64_FACTOR) & M;
  const factorB = (keyB * CS64_FACTOR) & M;

  const terms: bigint[] = CS64_COEFFICIENTS.map(([coeff], idx) => (coeff * (idx % 2 === 0 ? factorA : factorB)) & M);
  const offsets: bigint[] = CS64_COEFFICIENTS.map(([, off]) => off);

  const prefixed = new Uint8Array(1 + data.length);
  prefixed[0] = 0;
  prefixed.set(data, 1);

  const dataWords = wordsLe4Even(prefixed);
  for (let idx = 0; idx < dataWords.length; idx++) {
    const word = dataWords[idx];
    let term = word * (idx % 2 === 0 ? keyA : keyB);
    let offset = rol16(word) * (idx % 2 === 0 ? 0xef0569fbn : 0xc31713dbn);
    if (idx === 0) {
      term += CS64_ADJUSTMENT0 * factorA;
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term & M);
    offsets.push(offset & M);
  }

  let swapAcc = 0n;
  let swapLast = 0n;
  let state = 0n;
  let acc = 0n;

  for (let idx = 0; idx < terms.length; idx += 2) {
    const x = terms[idx];
    const y = terms[idx + 1];

    let t = rol16((offsets[idx] + x) & M);
    let q = (t * 0x76f50f34n) & M;
    swapAcc += (rol16(q) * 0xc3efea97n + q) & M;

    t = rol16((offsets[idx + 1] + y) & M);
    q = (t * 0x1881ce3cn) & M;
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & M;
    swapAcc = (swapAcc + swapLast) & M;

    state = (state * keyA + x) & M;
    state = (rol16(state) * 0xcf98b111n) & M;
    state = (rol16(state) * 0x87085b9fn) & M;
    state = (rol16(state) * 0x12ceb96dn) & M;
    state = (rol16(state) * 0x257e1d83n) & M;
    acc += state;

    t = (state * keyB + y) & M;
    t = (rol16(t) * 0xa27416f5n) & M;
    t = (rol16(t) * 0xd38396ffn) & M;
    state = (rol16((rol16(t) * 0x7c932b89n) & M) * 0xbfa49f69n) & M;
    acc = (acc + state) & M;
  }

  return [(swapLast ^ state) & M, (swapAcc ^ acc) & M];
}

function bytesToHexUpper(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function tokenHash(data: Uint8Array): [string, string] {
  const digest = sha256Digest(data);
  const [cs0, cs1] = cs64Digest(data, digest);
  const csBytes = new Uint8Array(8);
  const csView = new DataView(csBytes.buffer);
  csView.setUint32(0, Number(cs0 & M), true);
  csView.setUint32(4, Number(cs1 & M), true);
  return [bytesToHexUpper(csBytes), bytesToHexUpper(digest)];
}

/**
 * Generates a v2 Sec-MS-GEC token value ("<16 hex CS64>-<64 hex SHA256>").
 */
export function generateSecMsGecV2(
  unixSeconds: number,
  trustedClientToken: string = TRUSTED_CLIENT_TOKEN,
): string {
  let ticks = unixSeconds + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= S_TO_NS / 100;
  const strToHash = `${ticks.toFixed(0)}${trustedClientToken}`;
  const data = new TextEncoder().encode(strToHash);
  const [cs64, sha256] = tokenHash(data);
  return `${cs64}-${sha256}`;
}
