import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { claudeDataPlugin } from './vite-plugin-claude-data'

export default defineConfig({
  plugins: [react(), tailwindcss(), claudeDataPlugin()],
})
