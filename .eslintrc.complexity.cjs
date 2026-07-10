module.exports = {
  plugins: ['sonarjs'],
  rules: {
    'sonarjs/cognitive-complexity': ['error', 15],
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
};
