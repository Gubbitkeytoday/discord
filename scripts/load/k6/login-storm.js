// (a) Login storm — many users signing in at once (e.g. after an outage).
//
//   k6 run -e FIXTURE=fixture.json -e MAX_RATE=200 scripts/load/k6/login-storm.js
//
// Each iteration: POST /api/auth/login (scrypt verify + session insert) then
// GET /api/auth/me with the new bearer token, as the SPA does. The arrival rate
// steps up to MAX_RATE logins/s so the knee is visible in the per-step output.
//
// SAME_IP=1 sends every login from one address, to show the fixed
// 10-per-5-minutes per-IP login limit (lib/rateLimit.js) — a whole office or a
// mobile carrier NAT behind one IP hits it immediately.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { fixture, BASE, pick, randomIp, auth, steps } from './common.js';

const MAX = Number(__ENV.MAX_RATE || 100);
const loginMs = new Trend('login_ms', true);
const meMs = new Trend('me_ms', true);
const loginOk = new Rate('login_ok');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    storm: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, Math.round(MAX / 10)), timeUnit: '1s',
      preAllocatedVUs: 50, maxVUs: Number(__ENV.MAX_VUS || 1000),
      stages: steps(MAX, Number(__ENV.STEP_SECS || 15), Number(__ENV.STEPS || 4))
    }
  },
  thresholds: {
    login_ok: ['rate>0.99'],
    login_ms: ['p(95)<1000']
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max', 'count']
};

export default function () {
  const u = pick(fixture.users);
  const ip = __ENV.SAME_IP ? '10.9.9.9' : randomIp();
  const res = http.post(`${BASE}/api/auth/login`,
    JSON.stringify({ username: u.username, password: fixture.password, device: 'k6' }),
    { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, tags: { name: 'login' } });
  loginMs.add(res.timings.duration);
  const ok = check(res, { 'login 200': (r) => r.status === 200 });
  loginOk.add(ok);
  if (!ok) return;
  const token = res.json('token');
  const me = http.get(`${BASE}/api/auth/me`, { headers: auth(token, { 'X-Forwarded-For': ip }), tags: { name: 'me' } });
  meMs.add(me.timings.duration);
  check(me, { 'me 200': (r) => r.status === 200 });
}
