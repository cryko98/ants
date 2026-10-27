// Minimal Solana address helpers (replaces @solana/web3.js, whose websocket dependency
// fails to load in Vercel's Node runtime).
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

// True if the 32 bytes are a valid ed25519 point, i.e. an address with a private key (a wallet).
// PDAs (bonding curves, pools, vaults) are deliberately off the curve.
export function isOnCurve(address) {
  try {
    ed25519.Point.fromBytes(typeof address === 'string' ? bs58.decode(address) : address);
    return true;
  } catch {
    return false;
  }
}

// Same derivation as PublicKey.findProgramAddressSync: highest bump whose hash is off the curve.
export function findProgramAddress(seeds, programId) {
  const program = bs58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, PDA_MARKER];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const hash = sha256(buf);
    if (!isOnCurve(hash)) return [bs58.encode(hash), bump];
  }
  throw new Error('no viable program address');
}

export const decodeAddress = (address) => bs58.decode(address);
