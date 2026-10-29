import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';


// https://astro.build/config
export default defineConfig({
  integrations: [svelte({
    // Svelte 5 specific config if needed
  })],
  vite: {
    plugins: [
      tailwindcss() // Tailwind v4 Vite plugin
    ]
  },
  // Standalone it is served from /library/. The Treehouse build sets
  // LIBRARY_BASE so the same output also works under /treehouse/library/.
  base: process.env.LIBRARY_BASE || '/library/',
  
  // Optimize for mobile and fast builds
  build: {
    assetsInlineLimit: 4096,
  }
});