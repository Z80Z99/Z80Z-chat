import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default {
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src', '**', '*.{vue,ts,js}')
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        discord: {
          900: 'rgb(var(--chat-color-rail) / <alpha-value>)',
          800: 'rgb(var(--chat-color-nav) / <alpha-value>)',
          700: 'rgb(var(--chat-color-main) / <alpha-value>)',
          600: 'rgb(var(--chat-color-surface) / <alpha-value>)',
          500: 'rgb(var(--chat-color-hover) / <alpha-value>)',
          400: 'rgb(var(--chat-color-border-strong) / <alpha-value>)',
          300: 'rgb(var(--chat-color-text-muted) / <alpha-value>)',
          200: 'rgb(var(--chat-color-text-secondary) / <alpha-value>)',
          100: 'rgb(var(--chat-color-text-secondary) / <alpha-value>)',
          50: 'rgb(var(--chat-color-text-primary) / <alpha-value>)'
        },
        blurple: 'rgb(var(--chat-color-accent) / <alpha-value>)',
        'blurple-hover': 'rgb(var(--chat-color-accent-hover) / <alpha-value>)',
        green: 'rgb(var(--chat-color-success) / <alpha-value>)',
        'green-hover': 'rgb(var(--chat-color-success-hover) / <alpha-value>)',
        red: 'rgb(var(--chat-color-danger) / <alpha-value>)',
        'red-hover': 'rgb(var(--chat-color-danger-hover) / <alpha-value>)',
        yellow: 'rgb(var(--chat-color-warning) / <alpha-value>)'
      },
      width: {
        'server-bar': '72px',
        'channel-bar': '240px',
        'member-bar': '240px'
      },
      minWidth: {
        'server-bar': '72px',
        'channel-bar': '240px',
        'member-bar': '240px'
      }
    }
  },
  plugins: []
}
