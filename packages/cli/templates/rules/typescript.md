# TypeScript Conventions

Use TypeScript strict mode. Use ESM modules with `.js` extensions in imports
(e.g., `import { foo } from "./bar.js"`). Use the `node:` prefix for built-in
modules (e.g., `import { readFile } from "node:fs"`). Prefer `const` over
`let`, never use `var`. Use type imports for type-only imports:
`import type { Foo } from "./bar.js"`. No `any` types — use `unknown` with
type guards instead.

## Async & Error Handling

- Use `async`/`await` over raw Promises.
- Always handle errors explicitly — don't suppress them.
- Use `try/catch` with `async`/`await` consistently. Avoid mixing `.catch()`
  chains with `await` in the same flow.
- Use proper error types: create custom `Error` classes for domain-specific
  errors (e.g., `ConfigNotFoundError`, `SessionNotFoundError`).

## Code Organization

- Group related exports into focused modules with clear boundaries. Utility
  modules (e.g., `types.ts`, `metadata.ts`) may export multiple related items —
  prefer cohesion over arbitrary single-export splitting.
- Always use the `node:` prefix for Node.js built-in module imports.
- Use meaningful variable and function names (avoid single letters except in
  loops).
- Prefer composition over inheritance; use utility types (`Pick`, `Omit`,
  `Partial`, `Record`, etc.) for type composition.

## Interfaces & Types

- Use `interface` for public APIs and extensible contracts where declaration
  merging may be useful. Use `type` aliases for unions, tuples, and primitive
  compositions. In practice, `type` and `interface` are often interchangeable —
  consistency within a module matters more than a strict rule.
- Always fully type function parameters and return values — no implicit `any`.
- Use generics with constraints rather than loose typing
  (e.g., `<T extends { id: string }>` instead of bare `<T>`).
- Avoid deeply nested types; extract complex types into named type aliases.
