import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      react: path.resolve(dirname, 'node_modules/react'),
      'react-dom': path.resolve(dirname, 'node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(dirname, 'node_modules/react/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.resolve(dirname, 'node_modules/react/jsx-dev-runtime.js'),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // Long-lived vendor chunks so app deploys don't bust the framework cache.
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-router', test: /[\\/]node_modules[\\/](react-router|react-router-dom)[\\/]/ },
            { name: 'vendor-clerk', test: /[\\/]node_modules[\\/]@clerk[\\/]/ },
          ],
        },
      },
    },
  },
})
