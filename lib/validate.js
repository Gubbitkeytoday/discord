// Small input validators shared by services.

import { ApiError } from './httpUtils.js';

/**
 * A colour as the API stores it: '#rrggbb' (lower case) or null.
 *
 * Accepts '#RRGGBB', 'RRGGBB' or an integer 0..0xFFFFFF (Discord's wire
 * format). Anything else is refused: these values are interpolated into
 * inline styles on every client, so free text here is CSS injection.
 */
export function normaliseColor(value, field = 'color') {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) {
    return `#${value.toString(16).padStart(6, '0')}`;
  }
  if (typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value.trim())) {
    return `#${value.trim().replace(/^#/, '').toLowerCase()}`;
  }
  throw new ApiError(`${field} must be a hex colour like #5865f2`, { code: 'INVALID_COLOR', details: { field } });
}
