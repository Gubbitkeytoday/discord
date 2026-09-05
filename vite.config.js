import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
