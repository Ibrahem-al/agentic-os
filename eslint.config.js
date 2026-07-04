import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

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
    // Storage-abstraction boundary (spec §5, phase 01): only src/main/storage
    // may touch the RyuGraph driver; everything else uses the StorageEngine
    // interface so the engine stays swappable.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/main/storage/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'ryugraph',
              message: 'The RyuGraph driver is storage-internal — import from src/main/storage instead (spec §5).'
            }
          ]
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require'] > Literal[value='ryugraph']",
          message: 'The RyuGraph driver is storage-internal — use the StorageEngine from src/main/storage (spec §5).'
        }
      ]
    }
  }
)
