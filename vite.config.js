import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// PWA: stamp dist/sw.js (copied from public/) with this build's id and the
// hashed JS/CSS to precache. A new id is what makes browsers pick up a new
// service worker and offer "New version available".
function pwaServiceWorker() {
  let outDir = 'dist';
  let files = [];
  let allFiles = [];
  return {
    name: 'pwa-sw',
    apply: 'build',
    configResolved(resolved) { outDir = path.resolve(resolved.root, resolved.build.outDir); },
    generateBundle(_options, bundle) {
      // The app shell: the entry chunk, everything it imports statically, and
      // their CSS. Lazy chunks (modals, other locales) are cached on first use.
      const shell = new Set();
      const visit = (name) => {
        const chunk = bundle[name];
        if (!chunk || shell.has(name)) return;
        shell.add(name);
        if (chunk.type !== 'chunk') return;
        for (const css of chunk.viteMetadata?.importedCss ?? []) shell.add(css);
        for (const dep of chunk.imports ?? []) visit(dep);
      };
      for (const [name, chunk] of Object.entries(bundle)) if (chunk.type === 'chunk' && chunk.isEntry) visit(name);
      files = [...shell].filter((f) => /^assets\/.+\.(js|css)$/.test(f)).sort();
      allFiles = Object.keys(bundle).sort();
    },
    closeBundle() {
      const file = path.join(outDir, 'sw.js');
      // Read, then write the same path: no existsSync() check-then-use race.
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      const buildId = crypto.createHash('sha256').update(allFiles.join('\n')).digest('hex').slice(0, 12);
      const source = raw
        .replace("/*__BUILD_ID__*/'dev'", JSON.stringify(buildId))
        .replace('/*__PRECACHE__*/[]', JSON.stringify(files.map((f) => `/${f}`)));
      fs.writeFileSync(file, source);
    }
  };
}

// Long-lived third-party code in its own chunks: they change far less often
// than the app, so browsers keep them cached across deploys, and the app's
// entry chunk stays under Rollup's 500 kB warning.
const VENDOR_CHUNKS = [
  ['react', /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/],
  ['socket', /[\\/]node_modules[\\/](socket\.io-client|engine\.io-client|engine\.io-parser|socket\.io-parser|@socket\.io[\\/]component-emitter|debug|ms|xmlhttprequest-ssl)[\\/]/],
  ['icons', /[\\/]node_modules[\\/]lucide-react[\\/]/]
];

export default defineConfig({
  plugins: [react(), tailwindcss(), pwaServiceWorker()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [name, pattern] of VENDOR_CHUNKS) if (pattern.test(id)) return `vendor-${name}`;
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    watch: {
      ignored: [
        '**/discord.db*',
        '**/db/**',
        '**/public/uploads/**',
        '**/server.js',
        '**/db.js',
        '**/services/**',
        '**/routes/**',
        '**/lib/**',
        '**/scripts/**',
        '**/*.md',
        '**/package.json'
      ]
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      // Uploaded bytes are served by the API from STORAGE_ROOT at /uploads.
      //
      // This is easy to miss because no source file mentions the path: an
      // upload returns `{ url: "/uploads/avatars/3c/ec/….png" }` at runtime and
      // the browser resolves it against whatever origin the page came from.
      // In production that is the same process, so it just works. In dev the
      // page is served by Vite on :5173, and without this rule every uploaded
      // image — avatars, banners, server icons, emoji, stickers and message
      // attachments — silently 404s and renders blank.
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true
      }
    }
  }
});
