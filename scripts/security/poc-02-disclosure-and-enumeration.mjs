// M-class information-disclosure / enumeration checks, all from a single
// low-privilege perspective.
//
//   1. /metrics reachable with no credentials (operational + volume leak)
//   2. POST /api/auth/register is an e-mail existence oracle (409 CONFLICT),
//      which undermines the deliberately non-enumerating forgot-password path
//   3. GET /api/users hands any authenticated account the entire user
//      directory (id, username, presence) — global scraping / enumeration
import { api, newUser, verdict } from './_lib.mjs';

let bad = 0;

// 1 — metrics
const m = await api('GET', '/metrics', { raw: true });
console.log(`\n[1] GET /metrics (unauth) -> ${m.status}`);
if (m.status === 200) { bad++; console.log('    metrics served without a token'); }

// 2 — register e-mail oracle
const a = await newUser('probe');
const dup = await api('POST', '/api/auth/register',
  { body: { username: `x_${Date.now()}`, password: 'Passw0rd-abc', email: a.email } });
console.log(`\n[2] re-register with a known e-mail -> ${dup.status} ${JSON.stringify(dup.body)}`);
const oracle = dup.status === 409;
if (oracle) { bad++; console.log('    distinct response reveals the address is registered'); }

// 3 — global user directory
const dir = await api('GET', '/api/users', { token: a.token });
const count = Array.isArray(dir.body) ? dir.body.length : 0;
console.log(`\n[3] GET /api/users returned ${count} accounts to a brand-new user`);
if (count > 1) { bad++; console.log('    every account is enumerable by any member'); }

verdict(bad > 0, `${bad}/3 disclosure checks reproduced`);
