import { extendTheme } from 'native-base';
// Mirrors salon-contracts/tokens.json — same brand on web + mobile
export const theme = extendTheme({
  colors: {
    cream: { 50: '#FDFBF7', 100: '#F4EEE6' },
    plum: { 500: '#2D1B2E', 600: '#241624' },
    gold: { 400: '#C9A86A', 500: '#B8945A' },
    sage: { 500: '#7D8C7A' },
  },
  fontConfig: { Fraunces: { 600: { normal: 'serif' } } },
  fonts: { heading: 'Fraunces', body: 'Inter' },
  components: {
    Button: { defaultProps: { borderRadius: 'full' } },
    Card: { baseStyle: { borderRadius: 22 } },
  },
});
