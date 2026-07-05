import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

// Abstraction boundaries (enforced):
// - spec §5 / phase 01: only src/main/storage may touch the RyuGraph driver.
// - spec §9 / phase 04: only src/main/kernel may import LangGraph; agent code
//   sees the WorkflowRunner interface only. (Tests may import LangGraph types
//   to validate the checkpointer against the upstream contract.)
// - spec §12 / phase 05: only src/main/mcp may import the MCP SDK. (Tests may
//   import the SDK client to drive the server end to end.)
// - spec §18 / phase 07: only src/main/ingest may import Tree-sitter; the
//   rest of the app sees parseCodeFile / ingestCodebase.
const RYUGRAPH_PATH_RESTRICTION = {
  name: 'ryugraph',
  message: 'The RyuGraph driver is storage-internal — import from src/main/storage instead (spec §5).'
}
const LANGGRAPH_PATTERN_RESTRICTION = {
  group: ['@langchain/*'],
  message: 'LangGraph is kernel-internal — use the WorkflowRunner interface from src/main/kernel (spec §9).'
}
const MCP_SDK_PATTERN_RESTRICTION = {
  group: ['@modelcontextprotocol/*'],
  message: 'The MCP SDK is mcp-internal — import from src/main/mcp instead (spec §12).'
}
const TREE_SITTER_PATTERN_RESTRICTION = {
  group: ['web-tree-sitter', 'tree-sitter-*'],
  message: 'Tree-sitter is ingest-internal — use parseCodeFile / ingestCodebase from src/main/ingest (spec §18).'
}
const RYUGRAPH_REQUIRE_RESTRICTION = {
  selector: "CallExpression[callee.name='require'] > Literal[value='ryugraph']",
  message: 'The RyuGraph driver is storage-internal — use the StorageEngine from src/main/storage (spec §5).'
}

export default tseslint.config(
  // tests/fixtures/mini-repo is parse-fodder for the codebase-ingestion tests,
  // not project source — it deliberately references packages we don't install.
  // tests/fixtures/sandbox-probes runs only inside the phase-09 sandbox lanes
  // (Deno globals / POSIX sh) — never in the host toolchain.
  { ignores: ['node_modules', 'out', 'dist', 'resources', 'spike-data', 'docs', 'tests/fixtures/mini-repo', 'tests/fixtures/sandbox-probes'] },
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
    // Everything outside the boundary owners: no driver may be imported.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/main/storage/**', 'src/main/kernel/**', 'src/main/mcp/**', 'src/main/ingest/**', 'tests/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [RYUGRAPH_PATH_RESTRICTION],
          patterns: [LANGGRAPH_PATTERN_RESTRICTION, MCP_SDK_PATTERN_RESTRICTION, TREE_SITTER_PATTERN_RESTRICTION]
        }
      ],
      'no-restricted-syntax': ['error', RYUGRAPH_REQUIRE_RESTRICTION]
    }
  },
  {
    // Storage owns ryugraph but no other fenced dependency.
    files: ['src/main/storage/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [LANGGRAPH_PATTERN_RESTRICTION, MCP_SDK_PATTERN_RESTRICTION, TREE_SITTER_PATTERN_RESTRICTION] }
      ]
    }
  },
  {
    // Kernel owns LangGraph but no other fenced dependency.
    files: ['src/main/kernel/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [RYUGRAPH_PATH_RESTRICTION],
          patterns: [MCP_SDK_PATTERN_RESTRICTION, TREE_SITTER_PATTERN_RESTRICTION]
        }
      ],
      'no-restricted-syntax': ['error', RYUGRAPH_REQUIRE_RESTRICTION]
    }
  },
  {
    // MCP owns the MCP SDK but no other fenced dependency.
    files: ['src/main/mcp/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [RYUGRAPH_PATH_RESTRICTION],
          patterns: [LANGGRAPH_PATTERN_RESTRICTION, TREE_SITTER_PATTERN_RESTRICTION]
        }
      ],
      'no-restricted-syntax': ['error', RYUGRAPH_REQUIRE_RESTRICTION]
    }
  },
  {
    // Ingest owns Tree-sitter but no other fenced dependency.
    files: ['src/main/ingest/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [RYUGRAPH_PATH_RESTRICTION],
          patterns: [LANGGRAPH_PATTERN_RESTRICTION, MCP_SDK_PATTERN_RESTRICTION]
        }
      ],
      'no-restricted-syntax': ['error', RYUGRAPH_REQUIRE_RESTRICTION]
    }
  },
  {
    // Tests may import LangGraph (checkpointer contract tests) and the MCP
    // SDK client (server integration tests) but never the RyuGraph driver.
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [RYUGRAPH_PATH_RESTRICTION] }],
      'no-restricted-syntax': ['error', RYUGRAPH_REQUIRE_RESTRICTION]
    }
  }
)
