import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: { external: ['node:sqlite'] },
    },
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  preload: {
    // CommonJS : un preload exécuté dans un renderer isolé (sandbox) ne peut pas être un module ES.
    build: { externalizeDeps: true, rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
    plugins: [
      react(),
      // En production, aucune connexion WebSocket n'est nécessaire (rechargement à chaud uniquement en développement).
      { name: 'bcenter-csp', apply: 'build', transformIndexHtml: (html: string) => html.replace("connect-src 'self' ws:", "connect-src 'self'") },
    ],
  },
})
