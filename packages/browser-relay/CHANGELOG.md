# Changelog

## [Unreleased]

### Changed

- Documented the scope of the two relay opt-in paths: per-call `app.relay: true`, and the `browser.relay` setting as the profile-wide default across projects.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
