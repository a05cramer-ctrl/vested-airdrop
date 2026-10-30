// GET /api/drops?engine=<creator wallet>
// Payout history from the engine wallet: txs whose memo is VESTED|<unix hour>|<total lamports>,
// grouped by hour, recipients counted from Helius parsed native transfers.
import { dropsOf } from './_helius.js';
import { send, addr, fail } from './_http.js';

export default async function handler(req, res) {
  const engine = addr(req, res, 'engine'); if (engine === null) return;
  try {
    const drops = await dropsOf(engine, { limit: 500 });
    const totalPaid = drops.reduce((s, d) => s + d.paid, 0);
    send(res, 200, {
      engine, updatedAt: Date.now(), count: drops.length, totalPaid,
      drops: drops.slice(0, 72).map(({ payouts, ...d }) => d),
    }, 30);
  } catch (e) { fail(res, e); }
}
