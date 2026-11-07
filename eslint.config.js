import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      // Ninguna clave en el código: se detectan literales con aspecto de secreto.
      'no-restricted-syntax': ['error', {
        selector: "Literal[value=/^(sk-|AIza|ghp_|secret_|ntn_)[A-Za-z0-9_-]{10,}/]",
        message: 'Parece un secreto escrito en el código. Usa variables de entorno.'
      }]
    }
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    // Reglas clásicas de hooks. Las del compilador de React (set-state-in-effect…) marcan la carga de datos en efectos, que aquí es intencional.
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
  {
    // La web nunca importa código de servidor (ahí viven las claves).
    files: ['web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/server/**', '**/connectors/**', 'pg', '@modelcontextprotocol/*'] }]
    }
  }
);
