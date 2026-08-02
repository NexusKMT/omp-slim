# Changelog

## [Unreleased]

### Added

- Initial release: Chrome MV3 extension that lets the omp browser tool attach to and drive the user's existing tabs through `chrome.debugger`. The companion CDP relay lives in the omp CLI (`omp browser-relay`); this package builds the extension zip for GitHub releases and generates the embedded install assets consumed by `omp browser-relay install`. Controllable tabs are gathered into a per-window "omp" tab group while the relay is connected.
