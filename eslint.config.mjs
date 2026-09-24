import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', 'release/**', 'node_modules/**'] },

  js.configs.recommended,
  tseslint.configs.recommended,

  // Main, preload and the server run in Node/Electron.
  {
    files: [
      'electron/main/**/*.ts',
      'electron/preload/**/*.ts',
      'server/**/*.ts',
      'core/**/*.ts',
      'scripts/**/*.mjs',
      '**/vite.config.mts',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // The renderer is a browser document.
  {
    files: ['electron/adamant/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
  },

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
