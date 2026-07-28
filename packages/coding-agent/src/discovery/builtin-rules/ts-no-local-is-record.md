---
description: "Never define `isRecord` locally — use the shared guard, then validate the actual shape"
condition:
  - "\\bfunction\\s+isRecord(?:\\s*<[^>]*>)?\\s*\\("
  - "\\b(?:const|let|var)\\s+isRecord\\b\\s*(?::[\\s\\S]{0,300}?)?=\\s*(?:async\\s+)?(?:function\\b|(?:<[^>\\n]*>\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*(?::[\\s\\S]{0,300}?)?=>)"
scope: "tool:edit(*.{ts,tsx,mts,cts}), tool:write(*.{ts,tsx,mts,cts})"
interruptMode: never
---

**Never define `isRecord` locally.** Import the project's shared guard instead. It gives every caller the same object semantics and leaves shape validation where it belongs.

## Why it's wrong

- Local copies drift on `null`, arrays, and prototype semantics.
- A `Record<string, unknown>` guard proves only an object, not its fields.
- Repeated guards hide the actual data contract from readers and TypeScript.

## Use

```typescript
import { isRecord } from "@oh-my-pi/pi-utils";

if (!isRecord(value)) return;
const id = value.id;
if (typeof id !== "string") return;
```

`isRecord` narrows values to `Record<string, unknown>`; each field remains `unknown`.

For network, config, IPC, persisted, or reused data shapes, parse once at the boundary with the project's schema validator and consume its named output type:

```typescript
const Config = z.object({ retries: z.number().int().nonnegative() });
type Config = z.infer<typeof Config>;

const config = Config.parse(raw);
```

If the runtime shape is uncertain, check the properties you use with `typeof`, `Array.isArray`, `in`, or a discriminant. If an existing invariant guarantees the shape, assert the named type at that boundary instead of duplicating a guard:

```typescript
const config = value as Config;
```

## Avoid

```typescript
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object";
```

## Exceptions

A standalone package without a shared type-guard module may define its single canonical guard. Export it from the package's type-guard module; never recreate it at individual call sites.
