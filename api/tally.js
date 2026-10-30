// GET /api/tally?wallet=<addr>&mint=<CA?>&engine=<creator?>
// 30-day pump.fun + PumpSwap SOL volume from Helius parsed txs -> est. fees (1%) -> multiplier,
// plus $VESTED balance and est. share of the next drop.
import { RULES, multiplier, boardEstimate, shareEstimate } from './_core.js';
import { pumpVolume30d, balanceOf, eligibleOf, dropsOf, pendingFees } from './_helius.js';
import { send, addr, fail } from './_http.js';

export default async function handler(req, res) {
  const wallet = addr(req, res, 'wallet'); if (wallet === null) return;
  const mint = addr(req, res, 'mint', false); if (mint === null) return;
  const engine = addr(req, res, 'engine', false); if (engine === null) return;
  try {
    const [vol, balance, elig, drops, pending] = await Promise.all([
      pumpVolume30d(wallet, { maxPages: 8 }),
      mint ? balanceOf(wallet, mint) : Promise.resolve(null),
      mint ? eligibleOf(mint, engine || null) : Promise.resolve(null),
      engine ? dropsOf(engine, { limit: 60 }).catch(() => []) : Promise.resolve([]),
      engine ? pendingFees(engine).catch(() => null) : Promise.resolve(null),
    ]);
    const mult = multiplier(vol.fees);
    const eligible = balance != null && balance >= RULES.MIN_HOLD;
    const weight = eligible ? balance * mult : 0;
    let share = null, rank = null, estSol = null;
    if (elig && eligible) {
      const board = boardEstimate(elig.holders, drops[0] || null);
      const s = shareEstimate(wallet, weight, board.rows);
      share = s.share; rank = s.rank;
      if (pending) estSol = (pending.totalLamports / RULES.LAMPORTS_PER_SOL) * share;
    }
    send(res, 200, {
      wallet, updatedAt: Date.now(),
      volume30d: vol.volume, feesEst: vol.fees, mult,
      pumpTxs: vol.pumpTxs, scannedTxs: vol.txs, complete: vol.complete,
      balance, eligible, weight, rank, share, estSol,
    }, 120);
  } catch (e) { fail(res, e); }
}
