// Snowflake ID generator — Discord-compatible 64-bit IDs as decimal strings.
//
// Layout (from MSB):
//   42 bits  ms since DISCORD_EPOCH
//    5 bits  worker id
//    5 bits  process id
//   12 bits  per-ms sequence
//
// IDs are k-sortable: sorting by id === sorting by creation time, so message
// pagination never needs a created_at index and never ties.

export const DISCORD_EPOCH = 1420070400000n; // 2015-01-01T00:00:00Z

const WORKER_ID = BigInt(Number(process.env.WORKER_ID ?? 0) & 0b11111);
const PROCESS_ID = BigInt(process.pid & 0b11111);

let sequence = 0n;
let lastTimestamp = -1n;

export function generateId() {
  let now = BigInt(Date.now());

  if (now === lastTimestamp) {
    sequence = (sequence + 1n) & 0xfffn;
    if (sequence === 0n) {
      // Sequence exhausted for this millisecond — spin to the next one.
      while (BigInt(Date.now()) <= lastTimestamp) { /* busy wait, sub-ms */ }
      now = BigInt(Date.now());
    }
  } else {
    sequence = 0n;
  }

  // Clock moved backwards (NTP correction): keep issuing from the last known
  // millisecond rather than minting duplicates.
  if (now < lastTimestamp) now = lastTimestamp;
  lastTimestamp = now;

  const id =
    ((now - DISCORD_EPOCH) << 22n) |
    (WORKER_ID << 17n) |
    (PROCESS_ID << 12n) |
    sequence;

  return id.toString();
}

/** Creation time of a snowflake, as a JS Date. */
export function timestampOf(id) {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

/** Lowest snowflake that could have been created at or after `date`. */
export function snowflakeForDate(date) {
  const ms = BigInt(date instanceof Date ? date.getTime() : Number(date));
  return ((ms - DISCORD_EPOCH) << 22n).toString();
}

export function isSnowflake(value) {
  return typeof value === 'string' && /^\d{1,20}$/.test(value);
}
