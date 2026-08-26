import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * Lint configuration.
 *
 * ⚠️ Type-aware rules are on. They cost a TypeScript program per run - a few seconds - and they are
 * the only rules that can see the mistakes this codebase actually makes: a floating promise in a
 * process-spawning daemon, a `String(x)` on a value the vendor may send as an object, an assignment
 * of `any` out of `JSON.parse`. The untyped subset would have found none of the bugs this file's
 * first run found.
 *
 * ⛔ A rule is turned off here only with the reason written down. "It fired a lot" is not a reason;
 * "this rule is wrong about this codebase" is.
 */
export default tseslint.config(
  {
    ignores: ['out/**', 'release/**', 'dist/**', 'resources/**', '.icons-*/**', 'coverage/**']
  },

  // The suites in `test/` and the tooling in `scripts/`. These are `.mjs` on purpose - they run under
  // bare `node` with no build step - so they sit outside both tsconfigs and get the untyped rules.
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node }
  },

  {
    files: ['src/**/*.ts', 'src/**/*.tsx', '*.config.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      // ⛔ Off, and not negotiable: an `async` method here is usually satisfying an interface, not
      // doing I/O. `probeIdentity`, `probeQuota`, `canLand` and `preempt` are async because *some*
      // adapter or strategy must await something; the ones that answer from memory are the point of
      // the abstraction, not an oversight. Making them synchronous would branch the call sites.
      '@typescript-eslint/require-await': 'off',
      // `const { token: _token, ...safe } = endpoint` is how the renderer is kept from ever seeing
      // the daemon token. That idiom is a deliberate omission, not an unused variable.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }
      ]
    }
  },

  // Tests may reach for a method without calling it - `expect(adapter.writePermissions).toBe(...)`
  // is asking whether the capability is implemented at all, and never binds `this`.
  {
    files: ['src/**/*.test.ts'],
    rules: { '@typescript-eslint/unbound-method': 'off' }
  },

  // The renderer. ⛔ `rules-of-hooks` and `exhaustive-deps` earn their place: the fleet strip and the
  // terminal both subscribe to daemon events, and a missing dependency renders a stale worker list
  // that looks live.
  {
    files: ['src/renderer/**/*.tsx', 'src/renderer/**/*.ts'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      // ⚠️ Off with a caveat. This is a React Compiler rule, and it is right in general: an effect
      // whose body sets state renders twice. But every one of the eight it flags here is the same
      // shape - `useEffect(() => { void refresh() }, [refresh])`, a first load over RPC - and the
      // rule's remedy is a data-fetching library, not a smaller edit. Silencing it is a decision to
      // keep the pattern, and it should be revisited if the renderer ever grows one.
      'react-hooks/set-state-in-effect': 'off'
    }
  }
)
