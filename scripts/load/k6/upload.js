// (d) Small image uploads, then a message carrying the attachment.
//
//   node scripts/load/gen-images.mjs --dir /tmp/lt/img --count 300
//   k6 run -e FIXTURE=fixture.json -e IMG_DIR=/tmp/lt/img -e IMG_COUNT=300 \
//          -e RATE=10 -e DURATION=60s scripts/load/k6/upload.js
//
// POST /api/upload/attachments (multer memory storage → sha256 → sharp variants
// + blurhash → disk) then POST /api/messages with the returned file id. Images
// are distinct noise PNGs so content-addressed dedupe does not short-circuit
// the work; once IMG_COUNT is exhausted, uploads start hitting the dedupe path
// (reported as `deduped`). Upload budget is 30/min per user, so users rotate.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { fixture, BASE, pick, auth } from './common.js';

const N = Number(__ENV.IMG_COUNT || 100);
const DIR = __ENV.IMG_DIR || 'img';
const images = [];
for (let i = 0; i < N; i += 1) images.push(open(`${DIR}/img-${i}.png`, 'b'));

const uploadMs = new Trend('upload_ms', true);
const postMs = new Trend('attach_msg_ms', true);
const ok = new Rate('upload_ok');
const deduped = new Counter('deduped');

export const options = {
  scenarios: {
    uploads: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 10), timeUnit: '1s', duration: __ENV.DURATION || '60s',
      preAllocatedVUs: 20, maxVUs: Number(__ENV.MAX_VUS || 300)
    }
  },
  thresholds: { upload_ok: ['rate>0.99'], upload_ms: ['p(95)<1500'] },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max', 'count']
};

export default function () {
  const u = pick(fixture.users);
  const ch = pick(fixture.guilds[u.guild].channels);
  const i = (__ITER * 7 + __VU * 131) % N;
  const res = http.post(`${BASE}/api/upload/attachments`, {
    files: http.file(images[i], `shot-${i}.png`, 'image/png')
  }, { headers: auth(u.token), tags: { name: 'upload' } });
  uploadMs.add(res.timings.duration);
  const good = check(res, { 'upload 200': (r) => r.status === 200 });
  ok.add(good);
  if (!good) return;
  const att = res.json('attachments.0');
  if (att.deduped) deduped.add(1);
  const msg = http.post(`${BASE}/api/messages`,
    JSON.stringify({ channel_id: ch, content: 'screenshot', attachments: [{ file_id: att.id }] }),
    { headers: auth(u.token, { 'Content-Type': 'application/json' }), tags: { name: 'attach_msg' } });
  postMs.add(msg.timings.duration);
  ok.add(check(msg, { 'message 200': (r) => r.status === 200 }));
}
