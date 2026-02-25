import type { Config } from 'tailwindcss'

export default {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: '#0a0e27',
          surface: '#12162b',
          border: '#1e2540',
          text: '#e0e6ff',
          muted: '#8b92b8',
          green: '#00ff41',
          red: '#ff0044',
          yellow: '#ffaa00',
          cyan: '#00d9ff',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config
