// GENERATED from shared/ by build.mjs, edit shared/ instead.
// VESTED core: the payout rules + tiny Solana helpers.
// Single source of truth. build.mjs copies this file to site/api/_core.js and engine/lib/core.js.
// Pure Node (node:crypto only), no network, no dependencies.
import { createHash } from 'node:crypto';

export const RULES = Object.freeze({
  SUPPLY: 1_000_000_000,          // $VESTED total supply (tokens)
  DECIMALS: 6,                    // pump.fun mints use 6 decimals
  MIN_HOLD: 100_000,              // tokens needed at the snapshot to be eligible
  MAX_EXTRA: 9,                   // multiplier = 1 + min(9, F)
  FEE_RATE: 0.01,                 // F estimated as 1% of pump.fun + PumpSwap SOL volume
  FEE_WINDOW_DAYS: 30,
  TOP_N: 200,                     // top N eligible holders by weight are paid
  DUST_LAMPORTS: 1_000_000,       // payouts below 0.001 SOL are skipped and roll over
  MAX_TRANSFERS_PER_TX: 18,
  F_REFRESH_MS: 6 * 3600 * 1000,  // each wallet's F refreshed at most once per 6 h
  LAMPORTS_PER_SOL: 1_000_000_000,
});

export const PROGRAMS = Object.freeze({
  PUMP: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMP_AMM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  SYSTEM: '11111111111111111111111111111111',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  MEMO: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  WSOL: 'So11111111111111111111111111111111111111112',
});

// Rent-exempt minimum for a 0-byte system account (the pump creator vault).
export const RENT_EXEMPT_0 = 890_880;

/* ---------------- rules ---------------- */

export function multiplier(F) {
  const f = Number.isFinite(F) && F > 0 ? F : 0;
  return 1 + Math.min(RULES.MAX_EXTRA, f);
}

export function feesFromVolume(volumeSol) {
  return Math.max(0, volumeSol || 0) * RULES.FEE_RATE;
}

export const unixHour = (ms = Date.now()) => Math.floor(ms / 3_600_000);

export function memoText(hour, totalLamports) {
  return `VESTED|${hour}|${totalLamports}`;
}

export function parseMemo(str) {
  if (!str) return null;
  const m = /VESTED\|(\d+)\|(\d+)/.exec(str);
  return m ? { hour: Number(m[1]), total: Number(m[2]) } : null;
}

const MIN_RAW = RULES.MIN_HOLD * 10 ** RULES.DECIMALS;

/**
 * accounts: [{ owner, amount }] raw token amounts (token accounts, may repeat owners)
 * exclude: Set of owner addresses to drop (curve, pool, creator, ...)
 * isExcluded: optional fn(owner) -> bool (e.g. off-curve PDA check)
 * returns [{ owner, balance }] balance in whole tokens (float), eligible only, sorted desc
 */
export function eligibleHolders(accounts, exclude = new Set(), isExcluded = null) {
  const byOwner = new Map();
  for (const a of accounts) {
    if (!a || !a.owner) continue;
    const amt = Number(a.amount) || 0;
    if (amt <= 0) continue;
    byOwner.set(a.owner, (byOwner.get(a.owner) || 0) + amt);
  }
  const out = [];
  for (const [owner, raw] of byOwner) {
    if (exclude.has(owner)) continue;
    if (isExcluded && isExcluded(owner)) continue;
    if (raw < MIN_RAW) continue;
    out.push({ owner, balance: raw / 10 ** RULES.DECIMALS });
  }
  out.sort((x, y) => y.balance - x.balance || (x.owner < y.owner ? -1 : 1));
  return out;
}

/**
 * Wallets that could possibly land in the top 200 by weight.
 * Every one of the 200 largest holders has weight >= its balance, so the 200th weight is
 * at least B200 (the 200th largest balance). A wallet needs balance * 10 >= B200 to compete.
 */
export function candidates(eligible, topN = RULES.TOP_N) {
  if (eligible.length <= topN) return eligible.slice();
  const b200 = eligible[topN - 1].balance;
  const maxMult = 1 + RULES.MAX_EXTRA;
  return eligible.filter((h) => h.balance * maxMult >= b200);
}

/** holders [{owner, balance}], fees: Map|obj owner -> F (SOL). Returns top N by weight. */
export function rankByWeight(holders, fees, topN = RULES.TOP_N) {
  const get = (o) => (fees instanceof Map ? fees.get(o) : fees?.[o]);
  const ranked = holders.map((h) => {
    const F = Number(get(h.owner)) || 0;
    const mult = multiplier(F);
    return { owner: h.owner, balance: h.balance, F, mult, weight: h.balance * mult };
  });
  ranked.sort((a, b) => b.weight - a.weight || b.balance - a.balance || (a.owner < b.owner ? -1 : 1));
  return ranked.slice(0, topN);
}

/**
 * Split potLamports across ranked holders pro-rata by weight.
 * Payouts < DUST are skipped; skipped amounts + rounding remainder become carry (next hour).
 */
export function allocate(potLamports, ranked) {
  const pot = Math.max(0, Math.floor(Number(potLamports) || 0));
  const W = ranked.reduce((s, r) => s + r.weight, 0);
  const payouts = [];
  const skipped = [];
  if (pot === 0 || W <= 0) return { pot, payouts, skipped, paidTotal: 0, carry: pot };
  let paidTotal = 0;
  for (const r of ranked) {
    const lamports = Math.floor((pot * r.weight) / W);
    if (lamports < RULES.DUST_LAMPORTS) { skipped.push({ owner: r.owner, lamports }); continue; }
    payouts.push({ owner: r.owner, lamports, weight: r.weight, mult: r.mult });
    paidTotal += lamports;
  }
  // float safety: never pay more than the pot
  while (paidTotal > pot && payouts.length) {
    const over = paidTotal - pot;
    const last = payouts[payouts.length - 1];
    last.lamports -= over; paidTotal -= over;
    if (last.lamports < RULES.DUST_LAMPORTS) { paidTotal -= last.lamports; skipped.push({ owner: last.owner, lamports: last.lamports }); payouts.pop(); }
  }
  return { pot, payouts, skipped, paidTotal, carry: pot - paidTotal };
}

export function batches(list, size = RULES.MAX_TRANSFERS_PER_TX) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/* ---------- fee estimate from Helius enhanced (parsed) transactions ---------- */

const PUMP_IDS = new Set([PROGRAMS.PUMP, PROGRAMS.PUMP_AMM]);

export function isPumpTx(tx) {
  if (!tx || tx.transactionError) return false;
  if (tx.source === 'PUMP_FUN' || tx.source === 'PUMP_AMM') return true;
  for (const ix of tx.instructions || []) {
    if (PUMP_IDS.has(ix.programId)) return true;
    for (const inner of ix.innerInstructions || []) if (PUMP_IDS.has(inner.programId)) return true;
  }
  return false;
}

/** SOL volume (in SOL) the wallet moved in one pump.fun / PumpSwap tx. */
export function txSolVolume(tx, wallet) {
  if (!isPumpTx(tx)) return 0;
  let native = 0;
  const acct = (tx.accountData || []).find((a) => a.account === wallet);
  if (acct && Number.isFinite(acct.nativeBalanceChange)) {
    native = acct.nativeBalanceChange;
    if (native < 0 && tx.feePayer === wallet) native += Number(tx.fee) || 0; // ignore network fee
    native = Math.abs(native) / RULES.LAMPORTS_PER_SOL;
  }
  let wsol = 0;
  for (const t of tx.tokenTransfers || []) {
    if (t.mint !== PROGRAMS.WSOL) continue;
    if (t.fromUserAccount === wallet || t.toUserAccount === wallet) wsol += Math.abs(Number(t.tokenAmount) || 0);
  }
  return Math.max(native, wsol);
}

/* ---------------- base58 / PDA / on-curve ---------------- */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58MAP = Object.fromEntries([...B58].map((c, i) => [c, i]));

export function b58decode(str) {
  if (typeof str !== 'string' || !str.length) throw new Error('bad base58');
  let n = 0n;
  for (const c of str) {
    const v = B58MAP[c];
    if (v === undefined) throw new Error('bad base58');
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of str) { if (c === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}

export function isAddress(str) {
  try { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(str) && b58decode(str).length === 32; } catch { return false; }
}

const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
function pow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
const D = mod(-121665n * pow(121666n, P - 2n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

/** true when 32 bytes decode to a valid ed25519 point (i.e. a normal wallet key, not a PDA). */
export function isOnCurve(bytes) {
  if (bytes.length !== 32) return false;
  const b = Uint8Array.from(bytes);
  const sign = (b[31] & 0x80) !== 0;
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * pow(u * v7, (P - 5n) / 8n) % P;
  const vx2 = (v * x % P) * x % P;
  if (vx2 === u) { /* ok */ } else if (vx2 === mod(-u)) x = (x * SQRT_M1) % P; else return false;
  if (x === 0n && sign) return false;
  return true;
}

export const isOnCurveAddress = (addr) => { try { return isOnCurve(b58decode(addr)); } catch { return false; } };

const enc = (s) => (typeof s === 'string' ? new TextEncoder().encode(s) : s);

export function findPda(seeds, programId) {
  const prog = b58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(enc(s));
    h.update(Uint8Array.of(bump)); h.update(prog); h.update(enc('ProgramDerivedAddress'));
    const out = h.digest();
    if (!isOnCurve(out)) return [b58encode(out), bump];
  }
  throw new Error('no PDA');
}

const pk = (a) => b58decode(a);

export const pumpCreatorVault = (creator) => findPda(['creator-vault', pk(creator)], PROGRAMS.PUMP)[0];
export const pumpBondingCurve = (mint) => findPda(['bonding-curve', pk(mint)], PROGRAMS.PUMP)[0];
export const pumpPoolAuthority = (mint) => findPda(['pool-authority', pk(mint)], PROGRAMS.PUMP)[0];
export const ammCreatorVaultAuthority = (creator) => findPda(['creator_vault', pk(creator)], PROGRAMS.PUMP_AMM)[0];
export const ata = (owner, mint, tokenProgram = PROGRAMS.TOKEN) => findPda([pk(owner), pk(tokenProgram), pk(mint)], PROGRAMS.ATA)[0];
export const ammCreatorVaultAta = (creator) => ata(ammCreatorVaultAuthority(creator), PROGRAMS.WSOL);
export function pumpSwapPool(mint, index = 0) {
  const idx = Uint8Array.of(index & 0xff, (index >> 8) & 0xff);
  return findPda(['pool', idx, pk(pumpPoolAuthority(mint)), pk(mint), pk(PROGRAMS.WSOL)], PROGRAMS.PUMP_AMM)[0];
}

/** Owners never paid: bonding curve, canonical PumpSwap pool, its pool authority, the creator/engine. */
export function excludedOwners(mint, creator) {
  const s = new Set();
  if (mint) { s.add(pumpBondingCurve(mint)); s.add(pumpSwapPool(mint)); s.add(pumpPoolAuthority(mint)); }
  if (creator) s.add(creator);
  return s;
}

/**
 * Site-side board estimate (the site can't afford to look up 200 wallets' fee history every minute).
 * Multipliers are inferred from the last real drop: payout_i / balance_i is proportional to mult_i,
 * anchored so the lowest ratio in that drop = 1x. Wallets not in the last drop count as 1x.
 * holders: eligible [{owner, balance}]; lastDrop: { payouts: [{owner, lamports}] } | null
 */
export function boardEstimate(holders, lastDrop, topN = RULES.TOP_N) {
  const paid = new Map();
  for (const p of lastDrop?.payouts || []) paid.set(p.owner, (paid.get(p.owner) || 0) + p.lamports);
  let anchor = Infinity;
  for (const h of holders) { const l = paid.get(h.owner); if (l && h.balance > 0) anchor = Math.min(anchor, l / h.balance); }
  const known = Number.isFinite(anchor) && anchor > 0;
  const rows = holders.map((h) => {
    const l = paid.get(h.owner) || 0;
    const mult = known && l ? Math.min(1 + RULES.MAX_EXTRA, Math.max(1, l / h.balance / anchor)) : (known ? 1 : null);
    return { owner: h.owner, balance: h.balance, mult, inferred: !!(known && l), weight: h.balance * (mult || 1), lastPaid: l };
  });
  rows.sort((a, b) => b.weight - a.weight || b.balance - a.balance);
  return { rows: rows.slice(0, topN), multsKnown: known, totalWeight: rows.slice(0, topN).reduce((s, r) => s + r.weight, 0) };
}

/** Estimated share of the next drop for a wallet with `weight`, given the board of other wallets. */
export function shareEstimate(wallet, weight, boardRows, topN = RULES.TOP_N) {
  const others = boardRows.filter((r) => r.owner !== wallet).map((r) => r.weight).sort((a, b) => b - a);
  if (!(weight > 0)) return { share: 0, rank: null, inTop: false };
  let rank = 1;
  for (const w of others) if (w > weight) rank++;
  if (rank > topN) return { share: 0, rank, inTop: false };
  const keep = others.slice(0, topN - 1);
  const total = keep.reduce((s, w) => s + w, 0) + weight;
  return { share: weight / total, rank, inTop: true };
}
