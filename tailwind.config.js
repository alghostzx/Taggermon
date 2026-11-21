/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/client/**/*.{html,tsx,ts}'],
  theme: {
    extend: {
      colors: {
        // Official Srcery Color Scheme mapped across the application palette
        white: '#FCE8C3', // Srcery Bright White
        black: '#121212', // Srcery Hard Black
        slate: {
          50: '#FFF3DC',
          100: '#FCE8C3', // Srcery Bright White (primary text)
          200: '#E4D2AF', // Srcery Soft Bright White
          300: '#BAA67F', // Srcery White (standard text)
          400: '#918175', // Srcery Bright Black (muted labels/secondary text)
          500: '#76685E', // Srcery Dim Gray
          600: '#58524C', // Srcery Xgray6
          700: '#3A3734', // Srcery Xgray3 (input/button borders)
          800: '#2D2B28', // Srcery Xgray2 (card borders & secondary buttons)
          900: '#1C1B19', // Srcery Black (card & header surfaces)
          950: '#121212', // Srcery Hard Black (app background & inputs)
        },
        indigo: {
          50: '#EBF4FC',
          100: '#D6E9FA',
          200: '#B0D4F5',
          300: '#85BCEE',
          400: '#68A8E4', // Srcery Bright Blue
          500: '#458FD4',
          600: '#2C78BF', // Srcery Blue (primary brand accent)
          700: '#245F99',
          800: '#1D4975',
          900: '#183654',
          950: '#142433',
        },
        emerald: {
          50: '#F2F7E9',
          100: '#E2EFCF',
          200: '#C7E0A1',
          300: '#AED06E',
          400: '#98BC37', // Srcery Bright Green
          500: '#6FB043',
          600: '#519F50', // Srcery Green
          700: '#3F7D3E',
          800: '#315E30',
          900: '#244424',
          950: '#182817',
        },
        amber: {
          50: '#FFF8E7',
          100: '#FEEDB8',
          200: '#FDE088',
          300: '#FED06E', // Srcery Bright Yellow
          400: '#FCC44B',
          500: '#FBB829', // Srcery Yellow
          600: '#D75F00', // Srcery Orange
          700: '#AD4D00',
          800: '#853B00',
          900: '#5C2900',
          950: '#2E1B0C',
        },
        rose: {
          50: '#FDECEB',
          100: '#FBD5D2',
          200: '#F9B1AA',
          300: '#F88277',
          400: '#F75341', // Srcery Bright Red
          500: '#F34134',
          600: '#EF2F27', // Srcery Red
          700: '#C4241E',
          800: '#941C17',
          900: '#661512',
          950: '#301311',
        },
        cyan: {
          300: '#6CEEE0',
          400: '#2BE4D0', // Srcery Bright Cyan
          500: '#0AAEB3', // Srcery Cyan
          600: '#088B8F',
        },
        purple: {
          300: '#FF85AC',
          400: '#FF5C8F', // Srcery Bright Magenta
          500: '#E02C6D', // Srcery Magenta
          600: '#B82258',
        },
        pink: {
          300: '#FF85AC',
          400: '#FF5C8F', // Srcery Bright Magenta
          500: '#E02C6D', // Srcery Magenta
          600: '#B82258',
        },
      },
    },
  },
  plugins: [],
};
