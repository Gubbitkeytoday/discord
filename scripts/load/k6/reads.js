// (c) History pagination + search reads.
//
//   k6 run -e FIXTURE=fixture.json -e RATE=100 -e DURATION=60s scripts/load/k6/reads.js
//
// One iteration = a user scrolling back through a channel: newest 50, then two
// `before=` pages, and (SEARCH_RATIO of the time, default 0.3) a guild-scoped
// full-text search for a word the seed history contains. Each user id has its
// own 600 req/min read budget, so iterations spread over the fixture's users.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { fixture, BASE, pick, auth } from './common.js';

const pageMs = new Trend('history_page_ms', true);
const searchMs = new Trend('search_ms', true);
const ok = new Rate('read_ok');
const SEARCH_RATIO = Number(__ENV.SEARCH_RATIO || 0.3);
const WORDS = ['deploy', 'latency', 'incident', 'payment', 'socket', 'ทดสอบ', 'alpha', 'rollback'];

export const options = {
  scenarios: {
    reads: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50), timeUnit: '1s', duration: __ENV.DURATION || '60s',
      preAllocatedVUs: 50, maxVUs: Number(__ENV.MAX_VUS || 500)
    }
  },
  thresholds: { read_ok: ['rate>0.99'], history_page_ms: ['p(95)<500'], search_ms: ['p(95)<1000'] },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max', 'count']
};

export default function () {
  const u = pick(fixture.users);
  const g = fixture.guilds[u.guild];
  const ch = pick(g.channels);
  const h = { headers: auth(u.token) };

  let before = '';
  for (let page = 0; page < 3; page += 1) {
    const res = http.get(`${BASE}/api/messages/${ch}?limit=50${before}`,
      Object.assign({ tags: { name: `history_p${page}` } }, h));
    pageMs.add(res.timings.duration);
    const good = check(res, { 'history 200': (r) => r.status === 200 });
    ok.add(good);
    if (!good) return;
    const rows = res.json();
    if (!rows.length) break;
    before = `&before=${rows[0].id}`;
  }

  if (Math.random() < SEARCH_RATIO) {
    const res = http.get(`${BASE}/api/search/messages?q=${encodeURIComponent(pick(WORDS))}&serverId=${g.id}&limit=25`,
      Object.assign({ tags: { name: 'search' } }, h));
    searchMs.add(res.timings.duration);
    ok.add(check(res, { 'search 200': (r) => r.status === 200 }));
  }
}
