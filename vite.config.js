import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Same-origin proxies for the Polymarket APIs. Shared by `vite` (dev) and
// `vite preview`; a static production deploy of dist/ needs an equivalent
// reverse proxy, or every API call will receive the SPA's index.html.
const apiProxy = {
  '/gamma-api': {
    target: 'https://gamma-api.polymarket.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/gamma-api/, ''),
  },
  '/clob-api': {
    target: 'https://clob.polymarket.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/clob-api/, ''),
  },
  '/data-api': {
    target: 'https://data-api.polymarket.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/data-api/, ''),
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
})
