import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

const unused = ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }]

export default defineConfig([
  globalIgnores(['dist', 'server/data']),
  {
    files: ['src/**/*.{js,jsx}', 'vite.config.js'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { 'no-unused-vars': unused },
  },
  {
    files: ['server/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: { 'no-unused-vars': unused },
  },
])
