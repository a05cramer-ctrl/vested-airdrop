// GET /api/pending?engine=<creator wallet>
// Unclaimed creator fees right now:
//  - pump bonding curve: creator vault PDA ["creator-vault", creator] under 6EF8...F6P, lamports above rent
//  - PumpSwap: WSOL ATA of PDA ["creator_vault", creator] under pAMMBay6...EA
import { pendingFees } from './_helius.js';
import { send, addr, fail } from './_http.js';

export default async function handler(req, res) {
  const engine = addr(req, res, 'engine'); if (engine === null) return;
  try {
    const p = await pendingFees(engine);
    send(res, 200, { engine, updatedAt: Date.now(), ...p }, 30);
  } catch (e) { fail(res, e); }
}
