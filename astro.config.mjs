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
  // The site is served from https://adineo-cmd.github.io/library/, so every
  // asset and page URL is emitted under this base.
  base: '/library/',
  
  // Optimize for mobile and fast builds
  build: {
    assetsInlineLimit: 4096,
  }
});