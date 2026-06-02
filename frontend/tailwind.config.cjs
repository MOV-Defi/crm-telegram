module.exports = {
  content: {
    relative: true,
    files: [
      './index.html',
      './src/**/*.{js,ts,jsx,tsx}',
    ],
  },
  theme: {
    extend: {
      colors: {
        background: '#0f172a',
        surface: '#1e293b',
        primary: '#3b82f6',
      },
    },
  },
  plugins: [],
};
