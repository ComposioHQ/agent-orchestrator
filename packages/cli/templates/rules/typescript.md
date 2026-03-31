Use TypeScript strict mode.
Use ESM modules with .js extensions in imports (e.g., import { foo } from "./bar.js").
Use node: prefix for built-in modules (e.g., import { readFile } from "node:fs").
Prefer const over let, never use var.
Use type imports for type-only imports: import type { Foo } from "./bar.js".
No any types - use unknown with type guards instead.

## Async & Error Handling

- Use async/await over raw Promises.
- Always handle errors explicitly - don't suppress them.
- Use proper error types: create custom Error classes for domain-specific errors.
- Use try/catch for synchronous error handling, but prefer async error handling patterns for promises.

## Code Organization

- Keep files small and focused - aim for one primary export per file.
- Use meaningful variable and function names (avoid single letters except in loops).
- Prefer composition over inheritance; use utility types (Pick, Omit, Partial, Record, etc.) for type composition.
- Group related functionality into modules with clear boundaries.

## Interfaces & Types

- Use interfaces for public APIs and extensible contracts.
- Use type aliases for unions, tuples, and primitive compositions.
- Always fully type function parameters and return values - no implicit any.
- Use generics with constraints rather than loose typing (e.g., <T extends { id: string }>).
- Avoid deeply nested types; extract complex types into named type aliases.
