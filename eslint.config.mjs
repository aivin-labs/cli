import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // `{ secret: _s, ...rest }` bỏ trường khỏi bản sao — có chủ ý; tham số / biến tên `_x` = cố ý không dùng.
      'no-unused-vars': ['error', { ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Chạy bằng Bun (`bun scripts/build-binary.mjs`).
    files: ['scripts/build-binary.mjs'],
    languageOptions: { globals: { Bun: 'readonly' } },
  },
  prettier,
];
