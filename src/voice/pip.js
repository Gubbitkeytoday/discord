// ============================================================================
//  Pop-out call window via the Document Picture-in-Picture API.
//
//  Chromium (116+) can open an always-on-top window holding arbitrary DOM. The
//  call controls are rendered into it through a React portal, so they stay the
//  same live components — no second connection, no message passing. Elsewhere
//  the button is simply not shown (feature-detected).
// ============================================================================

export function isPipSupported() {
  return typeof window !== 'undefined'
    && 'documentPictureInPicture' in window
    && typeof window.documentPictureInPicture?.requestWindow === 'function';
}

/** Copy the app's stylesheets and theme attributes into the PiP document. */
function adoptStyles(target) {
  for (const sheet of [...document.styleSheets]) {
    try {
      const css = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      const style = target.document.createElement('style');
      style.textContent = css;
      target.document.head.appendChild(style);
    } catch {
      // Cross-origin sheet (e.g. a web font CSS): link it instead.
      if (sheet.href) {
        const link = target.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.document.head.appendChild(link);
      }
    }
  }
  const root = document.documentElement;
  for (const attr of [...root.attributes]) {
    if (attr.name === 'class' || attr.name.startsWith('data-') || attr.name === 'lang' || attr.name === 'dir') {
      target.document.documentElement.setAttribute(attr.name, attr.value);
    }
  }
  target.document.body.className = document.body.className;
  target.document.title = document.title;
}

/**
 * Open (or focus) the pop-out window. Must be called from a user gesture.
 * Resolves to the Window, or null when unsupported / refused.
 */
export async function openPipWindow({ width = 380, height = 260 } = {}) {
  if (!isPipSupported()) return null;
  const existing = window.documentPictureInPicture.window;
  if (existing) return existing;
  try {
    const pip = await window.documentPictureInPicture.requestWindow({ width, height });
    adoptStyles(pip);
    return pip;
  } catch {
    return null;
  }
}
