/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Same healthcare blue family as the Corporate Portal and mobile app.
        brand: {
          50: '#EEF5FF',
          100: '#D9E8FF',
          200: '#BCD6FE',
          300: '#8EBBFD',
          400: '#5995FA',
          500: '#3374F5',
          600: '#1A5BE0',
          700: '#1648BE',
          800: '#183E9A',
          900: '#19387A',
          950: '#0F224A',
        },
        ink: '#0B1B33',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 24 40 / 0.04), 0 1px 3px 0 rgb(16 24 40 / 0.05)',
        elevated: '0 16px 40px -16px rgb(15 34 74 / 0.22), 0 4px 10px -4px rgb(15 34 74 / 0.08)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': { from: { opacity: '0', transform: 'scale(.97)' }, to: { opacity: '1', transform: 'scale(1)' } },
        'slide-in-left': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
      },
      animation: {
        'fade-in': 'fade-in .15s ease-out',
        'scale-in': 'scale-in .16s ease-out',
        'slide-in-left': 'slide-in-left .22s ease-out',
      },
    },
  },
  plugins: [],
};
