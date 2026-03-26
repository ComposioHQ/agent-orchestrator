---
"@composio/ao-core": patch
---

Guard against empty `content` array and malformed JSON in decomposer

`classifyTask` and `decomposeTask` now use optional chaining on `res.content[0]`
so an empty content array from the Anthropic API no longer throws an unhandled
`TypeError`. `JSON.parse` in `decomposeTask` is wrapped in a try-catch that
includes the bad string in the error message. Adds a test file covering all
pure functions and LLM error paths.
