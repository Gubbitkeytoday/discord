import React, { useEffect, useState } from 'react';

/**
 * A QR code drawn as an SVG. The encoder (qrcode-generator: MIT, no
 * dependencies, ~20 kB) is loaded only when a QR code is actually shown —
 * the 2FA setup flow — so it never weighs on the main bundle.
 *
 * Dark modules on a white quiet zone regardless of theme: authenticator apps
 * read dark-on-light far more reliably.
 */
export default function QrCode({ value, size = 176, label }) {
  const [matrix, setMatrix] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setMatrix(null);
    if (!value) return undefined;
    import('qrcode-generator').then(({ default: qrcode }) => {
      if (cancelled) return;
      const qr = qrcode(0, 'M');
      qr.addData(value);
      qr.make();
      const count = qr.getModuleCount();
      const rows = [];
      for (let r = 0; r < count; r += 1) {
        const row = [];
        for (let c = 0; c < count; c += 1) row.push(qr.isDark(r, c));
        rows.push(row);
      }
      setMatrix(rows);
    }).catch(() => { if (!cancelled) setMatrix(false); });
    return () => { cancelled = true; };
  }, [value]);

  if (matrix === false) return null;
  const quiet = 4;
  const count = matrix?.length ?? 21;
  const extent = count + quiet * 2;
  // One path for every dark module keeps the DOM to a single node.
  let d = '';
  matrix?.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }));

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className="rounded-lg bg-white shrink-0"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      {matrix && <path d={d} fill="#000000" />}
    </svg>
  );
}
