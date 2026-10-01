import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';

// SonarQube is the authority on quality; the block for src/ is its fast local check.
// Sonar analyzes src/ as sources (sonar-project.properties), so the same rules run there:
// the sonarjs recommended set, less the rules the server's "Sonar way" TypeScript profile
// leaves inactive, plus the typescript-eslint and unicorn rules Sonar runs under its own
// keys. super-linear-regex stays on: it is how the plugin finds what the server reports
// as the S5852 regex hotspot.
//
// notInSonarWay: the rules of the sonarjs 4.2 recommended set whose Sonar keys are not
// active in the server's profile, from api/rules/search?qprofile=<Sonar way ts>&activation=true.
// Compare again when the plugin or the profile changes.
const notInSonarWay = [
  'no-extra-arguments', 'prefer-single-boolean-return', 'no-floating-point-equality',
  'no-unused-vars', 'future-reserved-words', 'null-dereference', 'no-implicit-global',
  'no-fixed-wait-in-tests', 'different-types-comparison', 'updated-const-var',
  'inconsistent-function-call', 'argument-type', 'in-operator-type-error',
  'array-callback-without-return', 'function-return-type',
  'no-incompatible-assertion-types', 'prefer-specific-assertions', 'no-trivial-assertions',
  'parameterized-tests', 'no-duplicate-test-title', 'async-test-assertions',
  'no-empty-test-title', 'hooks-before-test-cases', 'no-forced-browser-interaction',
  'assertions-in-test-cases', 'synchronous-suite-callback',
  'prefer-native-lodash-alternative', 'no-default-utility-imports', 'memoize-cache-key',
  'no-debug-commands-in-ui-tests', 'no-interpolation-in-inline-snapshots',
  'explicit-test-skip', 'no-empty-parameterized-test-dataset',
  'testing-library-query-assertion', 'synchronous-exception-assertions',
  'no-duplicate-parameterized-test-case', 'no-debounce-throttle-in-render',
  'avoid-mutating-nested-properties-of-shallow-clones', 'prefer-native-jquery-alternative',
  'no-vue-class-component', 'no-vue-mixins',
  'testing-library-prefer-query-by-disappearance', 'prefer-cypress-should',
  'no-mutate-reactive-state-in-updated-hook', 'vitest-mock-at-module-scope',
  'prefer-native-axios-alternative',
];

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/', '.vscode-test/', '*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      complexity: ['error', 10],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    name: 'crewforge/sonar-way-src',
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { ...sonarjs.configs.recommended.plugins, unicorn },
    rules: {
      ...sonarjs.configs.recommended.rules,
      ...Object.fromEntries(notInSonarWay.map((rule) => [`sonarjs/${rule}`, 'off'])),
      'sonarjs/no-commented-code': 'error', // S125, in the profile but not in recommended
      '@typescript-eslint/no-base-to-string': 'error', // S6551
      '@typescript-eslint/prefer-readonly': 'error', // S2933
      '@typescript-eslint/prefer-string-starts-ends-with': 'error', // S6557
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }], // S3863
      'unicorn/prefer-single-call': 'error', // S7778
      'unicorn/prefer-number-properties': 'error', // S7773
      'unicorn/prefer-string-raw': 'error', // S7780
      'unicorn/prefer-string-replace-all': 'error', // S7781
    },
  },
);
