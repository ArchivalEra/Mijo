// ESLint 配置 —— 用 sonarjs 把 GitRoll 的判据固定到本地，改之前就能红。
//
// GitRoll 每次扫描在 issue 里报「认知复杂度 N > 15」「嵌套模板字符串」
// 这类条目，但它们只能在扫描之后看到，改代码时无法自查。sonarjs 是
// Sonar 规则的 ESLint 实现，GitRoll 报的这几条正是它 recommended
// 里的同名规则 —— 于是同一套判据在本地 `npm run lint` 就能跑出来。
//
// 为什么不直接用 sonarjs 的 recommended 就完事：它还带 ~290 条针对
// 大型对象的规则（no-duplicate-string、max-lines 等），在 1400 行的
// 仓库里几乎全是噪声。这里只取与 GitRoll 报告交集的那几条。

import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';

/** 浏览器端与构建脚本的全局变量。site/ 没有打包器，直接跑在浏览器里。 */
const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  Image: 'readonly',
  URL: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  AbortController: 'readonly',
};

export default [
  { ignores: ['node_modules/**', 'site/catalogue.json'] },

  // ── 通用：语法层面的真错误 ──────────────────────────────────────
  {
    files: ['**/*.js', '**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      ...js.configs.recommended.rules,
      // catalogue 是生成物，页面上未用到的形参属于接口契约（如 label）。
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_' }],
      // 空 catch 是本仓的既定写法：失败即留空，原因由调用方装配。
      // 但不允许「什么都没说」的空 catch —— 必须留一行注释（见下方 no-empty）。
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // ── 派生脚本（Node）──────────────────────────────────────────────
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: NODE_GLOBALS },
  },

  // ── 浏览器端 ────────────────────────────────────────────────────
  {
    files: ['site/**/*.js'],
    languageOptions: { globals: BROWSER_GLOBALS },
  },

  // ── Sonar 判据：只留 GitRoll 报告里出现过的那几条 ─────────────────
  // 认知复杂度阈值取 8，比 GitRoll 的 15 更严：扫描只是事后报告，本地这条
  // 是提交前就拦。定 8 是因为实测该仓所有函数都能在 8 以内写清楚，
  // 超过 8 的基本都在同时干几件事。
  {
    files: ['scripts/**/*.mjs', 'site/**/*.js'],
    plugins: { sonarjs },
    rules: {
      'sonarjs/cognitive-complexity': ['error', 8],
      'sonarjs/no-nested-template-literals': 'error',
      'sonarjs/no-nested-conditional': 'error',
      // 「Prefer using an optional chain expression」没有对应规则：
      // sonarjs 4.x 不含此条，typescript-eslint 的同名规则需要类型信息
      // （projectService），为一处调用引入整套类型感知 lint 不划算。
      // 该处已手工改写，见 generate-catalogue.mjs 的 GitLab 头像补全。
    },
  },

  // ── 测试 ────────────────────────────────────────────────────────
  {
    files: ['tests/**/*.mjs'],
    languageOptions: { globals: NODE_GLOBALS },
  },
];
