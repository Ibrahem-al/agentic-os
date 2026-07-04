import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

// Abstraction boundaries (enforced):
// - spec §5 / phase 01: only src/main/storage may touch the RyuGraph driver.
// - spec §9 / phase 04: only src/main/kernel may import LangGraph; agent code
//   sees the WorkflowRunner interface only. (Tests may import LangGraph types
//   to validate the checkpointer against the upstream contract.)
const RYUGRAPH_PATH_RESTRICTION = {
  name: 'ryugraph',
  message: 'The RyuGraph driver is storage-internal — import from src/main/storage instead (spec §5).'
}
const LANGGRAPH_PATTERN_RESTRICTION = {
  group: ['@langchain/*'],
  message: 'LangGraph is kernel-internal — use the WorkflowRunner interface from src/main/kernel (spec §9).'
}
const RYUGRAPH_REQUIRE_RESTRICTION = {
  selector: "CallExpression[callee.name='require'] > Literal[value='ryugraph']",
  message: 'The RyuGraph driver is storage-internal — use the StorageEngine from src/main/storage (spec §5).'
}

export default tseslint.config(
  { ignores: ['node_modules', 'out', 'dist', 'resources', 'spike-data', 'docs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly', console: 'readonly', __dirname: 'readonly' }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    // Underscore prefix marks intentionally-unused parameters (interface
    // conformance, PHASE-09 stub signatures).
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // Everything outside both boundary owners: neither driver may be imported.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/main/storage/**', 'src/main/kernel/**', 'tests/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [RYUGRAPH_PATH_RESTRICTION], patterns: [LANGGRAPH_PATTERN_RESTRICTION] }
      ],
      'no-restricted-syntax': ['error', RYUGRAPH_REQUIRE_RESTRICTION]
    }
  },
  {
    // Storage owns ryugraph but must not import LangGraph.
    files: ['src/main/storage/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [LANGGRAPH_PATTERN_RESTRICTION] }]
    }
  },
  {
    // Kernel owns LangGraph but must not import the RyuGraph driver.
    files: ['src/main/kernel/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [RYUGRAPH_PATH_RESTRICTION] }],
      'no-restricted-syntax': ['error', RYUGRAPH_REQUIRE_RESTRICTION]
    }
  },
  {
    // Tests may import LangGraph (checkpointer contract tests) but never the
    // RyuGraph driver.
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [RYUGRAPH_PATH_RESTRICTION] }],
      'no-restricted-syntax': ['error', RYUGRAPH_REQUIRE_RESTRICTION]
    }
  }
)
