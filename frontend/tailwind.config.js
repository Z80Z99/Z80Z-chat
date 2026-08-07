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
          900: '#1e1f22',
          800: '#2b2d31',
          700: '#313338',
          600: '#383a40',
          500: '#404249',
          400: '#4e5058',
          300: '#6d6f78',
          200: '#949ba4',
          100: '#b5bac1',
          50: '#dbdee1'
        },
        blurple: '#5865f2',
        'blurple-hover': '#4752c4',
        green: '#23a55a',
        'green-hover': '#1a8c4a',
        red: '#da373c',
        'red-hover': '#a1282b',
        yellow: '#f0b232'
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
