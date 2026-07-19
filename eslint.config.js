import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^[A-Z_]',
        argsIgnorePattern: '^_',
        // Allow `const { search, ...rest } = filters` to strip keys
        ignoreRestSiblings: true,
      }],
      // The codebase deliberately mirrors frequently-changing values into
      // refs during render (e.g. `marketsRef.current = rawMarkets` in
      // App/ResultsTable/useAutoRefresh) so 7-updates/sec price ticks don't
      // recreate memoized row data. Those mirrors are read during render by
      // design; the effect-based alternative would read stale values. The
      // experimental refs rule cannot distinguish this pattern from misuse.
      'react-hooks/refs': 'off',
    },
  },
  {
    // Benchmarks run under Node (tsx), not the browser
    files: ['src/__benchmarks__/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
])
