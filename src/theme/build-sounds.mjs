// Writes public/sounds/<pack>/<event>.wav from src/theme/soundPacks.js.
// Usage: node src/theme/build-sounds.mjs   (deterministic; re-run after
// editing a pack — scripts/test-themes-71.mjs fails if the files are stale).
import fs from 'node:fs';
import path from 'node:path';
import { PACK_NOTES, PACK_EVENTS, renderEvent, encodeWav } from './soundPacks.js';

const OUT = path.resolve(import.meta.dirname, '../../public/sounds');
let total = 0;
for (const pack of Object.keys(PACK_NOTES)) {
  fs.mkdirSync(path.join(OUT, pack), { recursive: true });
  for (const event of PACK_EVENTS) {
    const bytes = encodeWav(renderEvent(pack, event));
    fs.writeFileSync(path.join(OUT, pack, `${event}.wav`), bytes);
    total += bytes.length;
  }
}
console.log(`wrote ${Object.keys(PACK_NOTES).length * PACK_EVENTS.length} files, ${(total / 1024).toFixed(1)} KiB`);
