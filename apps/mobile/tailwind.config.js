// Colours and type are lifted 1:1 from interactive-prototype/app.html so the
// app matches the approved design.
/** @type {import('tailwindcss').Config} */
const { COLORS } = require('./src/theme/colors');

module.exports = {
  content: ['./src/**/*.{js,jsx}'],
  presets: [require('nativewind/preset')],
  // The app is light-only. 'class' (not the default 'media') avoids a NativeWind web bug where
  // the dev server throws "Cannot manually set color scheme, as dark mode is type 'media'".
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        navy: '#0D2340', // headings
        ink: '#17233D', // body text
        slate: '#45526B', // field labels
        muted: '#5B6B84', // secondary text
        faint: '#97A4B8', // hints, timestamps
        line: '#E4E9F2', // card borders
        field: '#E1E7F0', // input borders
        divider: '#EEF1F6', // row separators
        canvas: '#F2F6FC', // screen background
        input: '#F7F9FC', // input background
        soft: '#EEF3FB', // icon buttons
        // the brand blue and its tints: src/theme/colors.js
        primary: { DEFAULT: COLORS.primary, soft: COLORS.primarySoft, dark: COLORS.primary, pressed: COLORS.primaryPressed, muted: COLORS.primaryMuted },
        success: { DEFAULT: '#1E8E4A', soft: '#E4F7EA', check: '#2FA84F' },
        danger: { DEFAULT: '#D64545', soft: '#FBEDED', line: '#F3C6C6', dark: '#B02A2A' },
        warning: { DEFAULT: '#B4740D', soft: '#FDF0DA' },
        cancel: { DEFAULT: '#C23B3B', soft: '#FBE9E9' },
        scheduled: { DEFAULT: '#5B4FE0', soft: '#EEF1FE' },
      },
      opacity: { 45: '0.45', 55: '0.55', 85: '0.85' },
      fontFamily: {
        inter: ['Inter_400Regular'],
        'inter-medium': ['Inter_500Medium'],
        'inter-semibold': ['Inter_600SemiBold'],
        'inter-bold': ['Inter_700Bold'],
        'inter-black': ['Inter_800ExtraBold'],
      },
    },
  },
  plugins: [],
};
