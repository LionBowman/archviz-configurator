import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  assetsInclude: ['**/*.hdr', '**/*.exr', '**/*.glb', '**/*.gltf'],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
