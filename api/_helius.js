// GENERATED from shared/ by build.mjs, edit shared/ instead.
// Helius readers shared by site/api and the engine (copied by build.mjs as _helius.js / helius.js).
// Uses global fetch (Node 18+). Every call needs HELIUS_API_KEY.
import {
  RULES, PROGRAMS, RENT_EXEMPT_0, isPumpTx, txSolVolume, feesFromVolume, multiplier, parseMemo,
  eligibleHolders, excludedOwners, isOnCurveAddress, pumpCreatorVault, ammCreatorVaultAta,
} from './_core.js';

const BASE = (process.env.HELIUS_API_BASE || 'https://mainnet.helius-rpc.com').replace(/\/$/, '');

export function heliusKey() {
  const k = process.env.HELIUS_API_KEY;
  if (!k) throw Object.assign(new Error('HELIUS_API_KEY missing'), { code: 'NOKEY' });
  return k;
}

const rpcUrl = () => `${BASE}/?api-key=${heliusKey()}`;

async function fetchJson(url, init, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(400 * (i + 1)); continue; }
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error(j?.error?.message || j?.error || `HTTP ${r.status}`), { body: j });
      return j;
    } catch (e) { last = e; if (e.body) throw e; await sleep(300 * (i + 1)); }
  }
  throw last;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rpc(method, params) {
  const j = await fetchJson(rpcUrl(), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'vested', method, params }),
  });
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

/** All token accounts of a mint via DAS getTokenAccounts (1000/page). */
export async function tokenAccountsOfMint(mint, maxPages = 50) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await rpc('getTokenAccounts', { mint, page, limit: 1000, options: { showZeroBalance: false } });
    const list = res?.token_accounts || [];
    for (const t of list) out.push({ owner: t.owner, amount: Number(t.amount) || 0 });
    if (list.length < 1000) break;
  }
  return out;
}

/** Eligible holders of the mint, excluding curve / pool / creator / any PDA-owned account. */
export async function eligibleOf(mint, creator) {
  const accounts = await tokenAccountsOfMint(mint);
  const exclude = excludedOwners(mint, creator);
  const pda = (o) => !isOnCurveAddress(o);
  return { holders: eligibleHolders(accounts, exclude, pda), accounts: accounts.length };
}

/** A wallet's $VESTED balance (tokens). */
export async function balanceOf(owner, mint) {
  const res = await rpc('getTokenAccounts', { owner, mint, page: 1, limit: 100 });
  const raw = (res?.token_accounts || []).reduce((s, t) => s + (Number(t.amount) || 0), 0);
  return raw / 10 ** RULES.DECIMALS;
}

/**
 * 30-day SOL volume on pump.fun bonding curves + PumpSwap for a wallet, from Helius parsed txs.
 * Stops early once the 10x cap is reached (F >= 9 SOL => 900 SOL volume).
 */
export async function pumpVolume30d(wallet, { maxPages = 10, nowMs = Date.now() } = {}) {
  const since = Math.floor(nowMs / 1000) - RULES.FEE_WINDOW_DAYS * 86400;
  const capVolume = RULES.MAX_EXTRA / RULES.FEE_RATE;
  let before = null, volume = 0, txs = 0, pumpTxs = 0, pages = 0, complete = false;
  while (pages < maxPages) {
    const q = new URLSearchParams({ 'api-key': heliusKey(), limit: '100', 'gte-time': String(since) });
    if (before) q.set('before-signature', before);
    let list;
    try {
      list = await fetchJson(`${BASE}/v0/addresses/${wallet}/transactions?${q}`);
    } catch (e) {
      // Helius may answer "...search period... before-signature parameter set to <sig>"
      const m = /set to ([1-9A-HJ-NP-Za-km-z]{60,100})/.exec(String(e?.body?.error || e.message));
      if (m) { before = m[1]; pages++; continue; }
      throw e;
    }
    pages++;
    if (!Array.isArray(list) || list.length === 0) { complete = true; break; }
    for (const tx of list) {
      if (tx.timestamp && tx.timestamp < since) { complete = true; break; }
      txs++;
      if (isPumpTx(tx)) { pumpTxs++; volume += txSolVolume(tx, wallet); }
    }
    if (complete || volume >= capVolume) { complete = true; break; }
    before = list[list.length - 1].signature;
    if (list.length < 100) { complete = true; break; }
  }
  const fees = feesFromVolume(volume);
  return { volume, fees, mult: multiplier(fees), txs, pumpTxs, pages, complete };
}

/** Unclaimed creator fees: pump creator vault (lamports above rent) + PumpSwap creator vault WSOL. */
export async function pendingFees(creator) {
  const vault = pumpCreatorVault(creator);
  const ammAta = ammCreatorVaultAta(creator);
  const [bal, ammBal] = await Promise.all([
    rpc('getBalance', [vault, { commitment: 'confirmed' }]),
    rpc('getTokenAccountBalance', [ammAta, { commitment: 'confirmed' }]).catch(() => null),
  ]);
  const curveLamports = Math.max(0, (bal?.value || 0) - RENT_EXEMPT_0);
  const ammLamports = Number(ammBal?.value?.amount || 0);
  return { vault, ammVault: ammAta, curveLamports, ammLamports, totalLamports: curveLamports + ammLamports };
}

/**
 * Payout history of the engine wallet, grouped by hour from VESTED| memos.
 * getSignaturesForAddress returns each tx's memo; recipients come from Helius parsed txs.
 */
export async function dropsOf(engine, { limit = 400 } = {}) {
  const sigs = await rpc('getSignaturesForAddress', [engine, { limit: Math.min(1000, limit) }]);
  const hits = [];
  for (const s of sigs || []) {
    if (s.err) continue;
    const m = parseMemo(s.memo);
    if (m) hits.push({ ...m, signature: s.signature, blockTime: s.blockTime });
  }
  const parsed = new Map();
  for (let i = 0; i < hits.length; i += 100) {
    const chunk = hits.slice(i, i + 100).map((h) => h.signature);
    const res = await fetchJson(`${BASE}/v0/transactions?api-key=${heliusKey()}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactions: chunk }),
    });
    for (const tx of res || []) parsed.set(tx.signature, tx);
  }
  const byHour = new Map();
  for (const h of hits) {
    const tx = parsed.get(h.signature);
    const transfers = (tx?.nativeTransfers || []).filter((t) => t.fromUserAccount === engine && t.toUserAccount !== engine && t.amount > 0);
    let d = byHour.get(h.hour);
    if (!d) { d = { hour: h.hour, total: h.total, paid: 0, recipients: 0, txs: [], blockTime: h.blockTime, payouts: [] }; byHour.set(h.hour, d); }
    d.txs.push(h.signature);
    d.recipients += transfers.length;
    for (const t of transfers) { d.paid += t.amount; d.payouts.push({ owner: t.toUserAccount, lamports: t.amount }); }
    d.blockTime = Math.max(d.blockTime || 0, h.blockTime || 0);
  }
  return [...byHour.values()].sort((a, b) => b.hour - a.hour);
}
