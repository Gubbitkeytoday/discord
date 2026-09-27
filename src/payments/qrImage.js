// QR helpers for the Support flow: the module matrix (shared with the SVG in
// the page) and a PNG a payer can save and pick from their photos in a
// banking app — those apps import images, not SVG.

export async function qrMatrix(value) {
  const { default: qrcode } = await import('qrcode-generator');
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
  return rows;
}

/**
 * Draw the QR with the amount and receiver underneath and download it.
 * Dark on white whatever the theme — scanners need the contrast.
 */
export async function downloadQrPng(value, { amountText = '', caption = '', filename = 'promptpay.png' } = {}) {
  const matrix = await qrMatrix(value);
  const count = matrix.length;
  const scale = 10;
  const quiet = 4;
  const qrSize = (count + quiet * 2) * scale;
  const pad = 24;
  const textBlock = 96;
  const canvas = document.createElement('canvas');
  canvas.width = qrSize + pad * 2;
  canvas.height = qrSize + pad * 2 + textBlock;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  matrix.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) ctx.fillRect(pad + (c + quiet) * scale, pad + (r + quiet) * scale, scale, scale);
  }));
  ctx.textAlign = 'center';
  const font = '"Sarabun", "Noto Sans Thai", system-ui, sans-serif';
  ctx.font = `700 34px ${font}`;
  ctx.fillText(amountText, canvas.width / 2, qrSize + pad + 44);
  ctx.font = `400 22px ${font}`;
  ctx.fillStyle = '#333333';
  ctx.fillText(caption.slice(0, 60), canvas.width / 2, qrSize + pad + 80);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Read the verification QR printed on a bank slip, where the browser can
 * (BarcodeDetector: Chrome on Android, Safari 17+ on some devices). The
 * server re-checks everything; this only lets the provider read the slip's
 * reference directly. Returns null when unsupported or not found.
 */
export async function readSlipQr(file) {
  try {
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
    const formats = await window.BarcodeDetector.getSupportedFormats?.();
    if (formats && !formats.includes('qr_code')) return null;
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    const bitmap = await window.createImageBitmap(file);
    const codes = await detector.detect(bitmap);
    bitmap.close?.();
    const raw = codes.map((c) => c.rawValue).find((v) => /^[0-9A-Za-z]{20,512}$/.test(v ?? '') && !v.startsWith('000201'));
    return raw ?? null;
  } catch {
    return null;
  }
}
