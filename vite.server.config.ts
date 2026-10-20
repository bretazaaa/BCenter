import { resolve } from 'node:path'
import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

// BCenter Server : moteur + serveur HTTP/WebSocket, exécuté par Node.js 24 (image Docker).
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'out/server',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'ws', 'ssh2', 'qrcode'],
      output: { format: 'es', entryFileNames: 'index.js' },
    },
  },
})
