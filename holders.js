// GET /api/holders?mint=<CA>&engine=<creator wallet>
// Eligible $VESTED holders (>= 100,000) via Helius DAS getTokenAccounts, minus bonding curve,
// PumpSwap pool, the engine/creator wallet and any PDA-owned account. Board weights are
// estimated from the last real drop (see boardEstimate in _core.js).
import { RULES, boardEstimate } from './_core.js';
import { eligibleOf, dropsOf } from './_helius.js';
import { send, addr, fail } from './_http.js';

export default async function handler(req, res) {
  const mint = addr(req, res, 'mint'); if (mint === null) return;
  const engine = addr(req, res, 'engine', false); if (engine === null) return;
  try {
    const [{ holders, accounts }, drops] = await Promise.all([
      eligibleOf(mint, engine || null),
      engine ? dropsOf(engine, { limit: 60 }).catch(() => []) : Promise.resolve([]),
    ]);
    const last = drops[0] || null;
    const board = boardEstimate(holders, last);
    send(res, 200, {
      mint, updatedAt: Date.now(), tokenAccounts: accounts,
      eligibleCount: holders.length,
      eligibleSupply: holders.reduce((s, h) => s + h.balance, 0),
      paidCount: Math.min(RULES.TOP_N, holders.length),
      multsFromHour: last ? last.hour : null,
      multsKnown: board.multsKnown,
      totalWeight: board.totalWeight,
      board: board.rows.slice(0, 50),
    }, 60);
  } catch (e) { fail(res, e); }
}
