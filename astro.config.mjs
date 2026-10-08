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
  // If you are deploying to GitHub Pages under a repo name (e.g., github.com/username/memex),
  // uncomment the line below and change 'memex' to your repo name.
  // base: '/memex/',
  
  // Optimize for mobile and fast builds
  build: {
    assetsInlineLimit: 4096,
  }
});