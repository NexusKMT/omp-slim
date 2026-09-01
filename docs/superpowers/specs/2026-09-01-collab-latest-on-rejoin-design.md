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

`Session` passes `snap.phase` from `app.tsx` to `Transcript`. `Transcript` watches that connection phase. When the phase changes to `live`, it enables the existing bottom lock and sets the transcript element's `scrollTop` to its `scrollHeight`.

The existing transcript-update effect continues to follow entries, streaming messages, active tools, and working-state changes while the bottom lock remains enabled. The existing scroll handler continues to disable the lock when you move more than 40 pixels from the bottom.

An empty transcript requires no special branch. Setting `scrollTop` to an empty element's `scrollHeight` is safe.

## Files

- `packages/collab-web/src/app.tsx`: Pass the connection phase to the transcript.
- `packages/collab-web/src/components/transcript/Transcript.tsx`: Reset tail-follow when the connection reaches `live`.
- `packages/collab-web/test/transcript.test.tsx`: Cover join, reconnect, and manual scrolling behavior.
- `packages/collab-web/CHANGELOG.md`: Record the user-visible fix.

## Verification

Add focused transcript tests that prove:

1. An initial connection opens at the latest message.
2. A reconnect opens at the latest message after you previously scrolled upward.
3. Manual upward scrolling still disables automatic following after the reconnect jump.

Run the collab web transcript test and the package type check. Then open a live collab link, scroll upward, disconnect and rejoin, and confirm that the latest message appears without manual scrolling.

## Risk and rollback

The change affects only collab web transcript positioning. The main risk is overriding intentional reading position during a reconnect; the approved behavior requires that override. Reverting the phase-driven lock reset restores the current behavior without changing stored data or protocol state.
