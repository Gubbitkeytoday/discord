import React from 'react';

/**
 * The active season's small decoration (art and visibility come from
 * index.css `:root[data-season]`; nothing renders outside a season, under
 * high contrast or forced colours). Decorative only — hidden from assistive
 * tech. Place it in a header next to the title, e.g. the channel header.
 */
export default function SeasonalArt({ className = '' }) {
  return <span aria-hidden="true" className={`season-art ${className}`} />;
}
