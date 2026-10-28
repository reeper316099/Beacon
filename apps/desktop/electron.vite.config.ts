import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Workspace packages ship TypeScript source, so they are bundled; real deps stay external.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: [
          '@beacon/apps',
          '@beacon/core',
          '@beacon/jsonstore',
          '@beacon/matcher',
          '@beacon/shared',
        ],
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          searchWorker: resolve(__dirname, 'src/worker/search.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: [
          '@beacon/apps',
          '@beacon/core',
          '@beacon/jsonstore',
          '@beacon/matcher',
          '@beacon/shared',
        ],
      },
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
  },
})
