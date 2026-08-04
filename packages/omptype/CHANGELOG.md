# Changelog

## [Unreleased]

### Added

- Added `io: 'input'` and `io: 'output'` options to `toJsonSchema()`, supporting input validation shapes and piped `.to()` target types
- Added Standard Schema V1 interop: every schema exposes `~standard` with synchronous validation, enabling direct use with `@t3-oss/env`, tRPC, and other Standard Schema consumers.
- Added `fromJsonSchema()`, rebuilding callable schemas from JSON Schema documents (draft-07 / draft-2020-12 structural keywords, string formats, `$defs` recursion, enums, and `anyOf`/`oneOf`/`allOf` composition) — the inverse of `Type.toJsonSchema()`.

## [17.2.7] - 2026-08-03

### Added

- Introduced omptype, an ArkType-compatible schema validation library featuring a lazy JIT runtime that compiles specialized validators on the third call for ultra-fast hot-path validation and low construction overhead.
- Added support for a rich string definition DSL (primitives, literals, unions, arrays, bounds, inline defaults, and optional keys), object definitions (including index signatures and strict key rejection/deletion), and comprehensive composition methods (.or, .and, .array, .pipe, .narrow, .describe, .default, .allows, .assert).
- Added TypeBox-style (@oh-my-pi/omptype/typebox) and Zod-style (@oh-my-pi/omptype/zod) authoring adapters that produce native omptype schemas.
- Added support for recursive named scopes, modules, runtime generics, fixed/optional/variadic tuples, Date literals/bounds, disjointness-aware intersections, separate input/output inference, and draft-2020-12 JSON Schema emission.
- Shipped transpiled ESM and TypeScript declarations in the npm package to support plain Node.js environments, while preserving TS source resolution for Bun consumers.

### Changed

- Optimized the lazy JIT compiler to support tuples, refinements, morphs, intersections, instances, and recursive aliases, while reducing schema construction overhead.

### Fixed

- Fixed a TypeScript compiler error (TS2589: "type instantiation is excessively deep") when using generic fluent composition methods on nested schemas.
- Fixed type.raw() results (BaseType) to correctly expose fluent composition methods like .array(), .or(), and .pipe().
- Fixed an issue in the TypeBox adapter where keyword-carrying schemas (e.g., uniqueItems arrays) would throw an error during JSON Schema emission.
