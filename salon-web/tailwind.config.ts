import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        primary: { DEFAULT: '#2D1B2E', fg: '#FDFBF7' },
        accent: { DEFAULT: '#C9A86A', fg: '#2D1B2E' },
        ink: '#1A1517',
        line: '#E8DFD3',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl2: '14px', xl3: '22px' },
    },
  },
  plugins: [],
};
export default config;
