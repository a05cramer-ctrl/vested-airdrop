// Small response helpers shared by the api routes (files starting with _ are not routes on Vercel).
import { isAddress } from './_core.js';

export function send(res, status, body, sMaxAge = 60) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', status === 200 ? `public, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge * 2}` : 'no-store');
  res.setHeader('access-control-allow-origin', '*');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

export function param(req, name) {
  const url = new URL(req.url, 'http://x');
  return (url.searchParams.get(name) || '').trim();
}

/** Required address param; returns null after sending 400 when bad. */
export function addr(req, res, name, required = true) {
  const v = param(req, name);
  if (!v && !required) return '';
  if (!isAddress(v)) { send(res, 400, { error: `bad or missing ${name}` }); return null; }
  return v;
}

export function fail(res, e) {
  const code = e?.code === 'NOKEY' ? 503 : 502;
  send(res, code, { error: code === 503 ? 'server has no HELIUS_API_KEY' : 'chain read failed', detail: String(e?.message || e).slice(0, 200) });
}
