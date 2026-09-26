// Shared bits for the k6 scenarios. k6 runs goja (ES2015+ modules), not Node.
//
//   FIXTURE   path to the seed.mjs output (required)
//   BASE_URL  overrides fixture.url

export const fixture = JSON.parse(open(__ENV.FIXTURE || 'fixture.json'));
export const BASE = __ENV.BASE_URL || fixture.url;

export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** A random client address; the server trusts X-Forwarded-For from loopback. */
export function randomIp() {
  const b = () => 1 + Math.floor(Math.random() * 254);
  return `10.${b()}.${b()}.${b()}`;
}

export function auth(token, extra) {
  return Object.assign({ Authorization: `Bearer ${token}` }, extra || {});
}

/** Stages for a ramping-arrival-rate executor: step up to MAX over the run. */
export function steps(max, stepSecs, n) {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const target = Math.round((max * i) / n);
    out.push({ target, duration: '5s' }, { target, duration: `${stepSecs}s` });
  }
  return out;
}
