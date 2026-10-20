import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Interface de BCenter Server, servie au navigateur (même code React que l'application Windows).
export default defineConfig({
  root: 'src/renderer',
  base: '/',
  resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
  plugins: [
    react(),
    // La politique de sécurité est envoyée par le serveur (en-têtes HTTP) : la balise de l'application Windows est retirée.
    { name: 'bcenter-web-csp', transformIndexHtml: (html: string) => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '') },
  ],
  build: { outDir: resolve('out/web'), emptyOutDir: true },
})
