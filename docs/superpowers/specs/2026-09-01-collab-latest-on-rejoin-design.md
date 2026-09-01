# Show the latest message after collab rejoin

## Problem

The collab web transcript preserves its bottom-lock state when `App` replaces a disconnected `GuestClient`. If you scroll upward before a disconnect, `Transcript` keeps `lockRef` disabled after the replacement client reaches `live`. The refreshed transcript therefore opens at the previous scroll position instead of the latest message.

## Behavior

When a collab connection first reaches `live`, or reaches `live` after a reconnect, the transcript jumps to its latest message once. After that jump, the existing bottom-lock behavior remains unchanged:

- If you stay near the bottom, new content remains visible.
- If you scroll upward, automatic following stops.
- If you reconnect, the transcript returns to the latest message regardless of the prior scroll position.

This behavior applies automatically. It does not add a preference, local storage, or a new control.

## Design

`Session` passes `snap.phase` from `app.tsx` to the main `Transcript`. The new `phase?: ConnectionPhase` prop remains optional because `AgentDrawer` also renders `Transcript` without a session connection phase. When the main transcript's phase changes to `live`, it enables the existing bottom lock and sets the transcript element's `scrollTop` to its `scrollHeight`. The compact agent transcript remains unchanged.

`Transcript.tsx` exposes the two small scroll operations that the component already needs: follow the tail when locked, with an explicit force option for a `live` transition, and update the lock from the current scroll geometry. The entry-update effect, phase effect, and scroll handler use these operations. This test seam accepts a scroll element and the existing lock reference; it does not add a controller, state machine, or dependency.

An empty transcript requires no special branch. Setting `scrollTop` to an empty element's `scrollHeight` is safe.

## Files

- `packages/collab-web/src/app.tsx`: Pass the connection phase to the transcript.
- `packages/collab-web/src/components/transcript/Transcript.tsx`: Add the optional connection phase, reset tail-follow when it reaches `live`, and expose the existing scroll operations for focused tests.
- `packages/collab-web/test/transcript.test.tsx`: Exercise the scroll operations with a fake element.
- `packages/collab-web/CHANGELOG.md`: Record the user-visible fix.

## Verification

Add focused transcript tests that use a fake scroll element and prove this sequence:

1. Entering `live` enables the lock and moves to the latest message.
2. Scrolling more than 40 pixels upward disables the lock.
3. A subsequent content update leaves the scroll position unchanged.
4. A `reconnecting` to `live` transition enables the lock and returns to the latest message.

Run the collab web transcript test and the package type check. Then open a live collab link, scroll upward, disconnect and rejoin, and confirm that the latest message appears without manual scrolling. The live-link smoke check verifies the React effect wiring that the current static-render test environment cannot execute.

## Risk and rollback

The change affects only collab web transcript positioning. The main risk is overriding intentional reading position during a reconnect; the approved behavior requires that override. Reverting the phase-driven lock reset restores the current behavior without changing stored data or protocol state.
