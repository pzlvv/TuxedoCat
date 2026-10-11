import tseslint from 'typescript-eslint';
import eslint from '@eslint/js';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-undef': 'off',
      'no-empty': 'off',
      'no-unsafe-finally': 'off',
      'no-constant-condition': 'off',
      'no-case-declarations': 'off',
      'prefer-const': 'warn',
    },
  },
  // 分层依赖边界（AGENTS.md 第 1 节的可执行形态）：import type 同样是编译期耦合，一并拦截。
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/host/**', '**/host', 'host/**', 'host'],
              message: 'core 不得 import host/ 的实现；core 只通过 requireEventBus() 发事件（AGENTS.md 第 1 节）。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/host/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['vscode', 'vscode/*', 'electron', 'electron/*'],
              message: 'host/ 不得 import vscode / electron；宿主差异收在 UIHost / SpinDesign / ConversationManager 上（AGENTS.md 第 1 节）。',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
