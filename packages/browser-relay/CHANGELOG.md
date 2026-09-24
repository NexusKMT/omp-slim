# Changelog

## [Unreleased]

### Fixed

- The browser relay now supports several browser instances (for example Chrome and Edge) connected at the same time: tab registries are namespaced per extension instance, hello garbage-collection is scoped to the reconnecting instance, RPCs route to the browser that owns the tab, and target ids encode the instance (`PAGE<seq>.<tabId>`). The bundled extension sends a stable per-install instance id.

## [18.0.7] - 2026-08-26

### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
