# Collab latest-message rejoin implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the main collab transcript open at its latest message whenever the connection first reaches or returns to `live`.

**Architecture:** Pass the existing `GuestSnapshot.phase` into the main transcript through an optional prop. Reuse the current bottom lock through two small exported scroll operations so focused Bun tests can exercise browser geometry without adding a DOM dependency. Keep the compact agent transcript and manual upward scrolling unchanged.

**Tech Stack:** TypeScript, React, Bun test, OMP collab web

---

### Task 1: Reset transcript tail-follow on live connections

**Files:**
- Modify: `packages/collab-web/test/transcript.test.tsx`
- Modify: `packages/collab-web/src/components/transcript/Transcript.tsx:1-21,241-290`
- Modify: `packages/collab-web/src/app.tsx:122-177`

- [ ] **Step 1: Write the failing scroll behavior test**

Add imports for the two scroll operations from `Transcript.tsx`. Add one test that uses a mutable fake element and lock reference:

```tsx
import {
	followTranscriptTail,
	Transcript,
	updateTranscriptTailLock,
} from "../src/components/transcript/Transcript";

it("restores tail-follow when a connection becomes live", () => {
	const element = { scrollTop: 0, scrollHeight: 1_000, clientHeight: 200 };
	const lock = { current: false };

	followTranscriptTail(element, lock, true);
	expect(lock.current).toBe(true);
	expect(element.scrollTop).toBe(1_000);

	element.scrollTop = 600;
	updateTranscriptTailLock(element, lock);
	expect(lock.current).toBe(false);

	element.scrollHeight = 1_200;
	followTranscriptTail(element, lock);
	expect(element.scrollTop).toBe(600);

	followTranscriptTail(element, lock, true);
	expect(lock.current).toBe(true);
	expect(element.scrollTop).toBe(1_200);
});
```

This sequence represents the initial `live` transition, manual scrolling more than 40 pixels from the bottom, a content update while unlocked, and the next `reconnecting` to `live` transition.

- [ ] **Step 2: Run the focused test and verify that it fails**

Run:

```bash
bun test packages/collab-web/test/transcript.test.tsx
```

Expected: FAIL because `followTranscriptTail` and `updateTranscriptTailLock` do not exist.

- [ ] **Step 3: Add the minimal scroll operations**

In `Transcript.tsx`, import `ConnectionPhase` with `ActiveTool`. Add structural types and exported functions near `TranscriptProps`:

```tsx
import type { ActiveTool, ConnectionPhase } from "../../lib/client";

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}

export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}
```

Add the optional prop so `AgentDrawer` remains compatible:

```tsx
phase?: ConnectionPhase;
```

Destructure `phase` in `Transcript`. Replace the existing entry-update body and scroll-handler arithmetic with the two operations. Add a separate phase effect:

```tsx
useEffect(() => {
	const el = rootRef.current;
	if (el !== null) followTranscriptTail(el, lockRef);
}, [entries, stream, activeTools, working]);

useEffect(() => {
	const el = rootRef.current;
	if (phase === "live" && el !== null) followTranscriptTail(el, lockRef, true);
}, [phase]);
```

The phase guard prevents the optional prop from changing compact agent transcripts.

- [ ] **Step 4: Pass the main connection phase**

In the `Transcript` call in `app.tsx`, add:

```tsx
phase={snap.phase}
```

Do not pass a phase from `AgentDrawer`.

- [ ] **Step 5: Run the focused test and type check**

Run:

```bash
bun test packages/collab-web/test/transcript.test.tsx
bun run --cwd packages/collab-web check:types
```

Expected: Both commands exit with status 0. The transcript test includes the existing Markdown and live-tool cases plus the new scroll sequence.

- [ ] **Step 6: Commit the behavior change**

```bash
git add packages/collab-web/test/transcript.test.tsx packages/collab-web/src/components/transcript/Transcript.tsx packages/collab-web/src/app.tsx
git commit -m "fix(collab): show latest message after rejoin"
```

### Task 2: Document and verify the user-visible behavior

**Files:**
- Modify: `packages/collab-web/CHANGELOG.md:3-5`

- [ ] **Step 1: Add the changelog entry**

Under `## [Unreleased]`, add:

```markdown
### Fixed

- The guest transcript now returns to the latest message after an initial connection or reconnect.
```

- [ ] **Step 2: Run package verification**

Run:

```bash
bun test packages/collab-web/test/transcript.test.tsx
bun run --cwd packages/collab-web check:types
bun run --cwd packages/collab-web build
```

Expected: All commands exit with status 0.

- [ ] **Step 3: Verify the actual collab surface**

Start the local web app:

```bash
bun run --cwd packages/collab-web dev
```

Use the Mayor room fragment with `http://localhost:3000/#<roomId>.<key>`. In a browser:

1. Confirm that the transcript opens at the latest message.
2. Scroll more than 40 pixels upward and confirm that new content does not move the viewport.
3. Use the existing rejoin action after a disconnect.
4. Confirm that the transcript returns to the latest message without manual scrolling.

Expected: Initial join and rejoin show the latest message, while manual scrolling still pauses tail-follow between connections.

- [ ] **Step 4: Commit the changelog**

```bash
git add packages/collab-web/CHANGELOG.md
git commit -m "docs(collab): note latest-message rejoin fix"
```

- [ ] **Step 5: Inspect the final change**

Review the committed changes against `docs/superpowers/specs/2026-09-01-collab-latest-on-rejoin-design.md`. Confirm that no setting, storage, control, dependency, or `AgentDrawer` behavior changed.
