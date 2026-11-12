//! Apple's `NSSpellChecker` shared services for omp.
//!
//! `pi_natives::spelling` (typo ranges, replacement guesses, autocorrection)
//! submits every AppKit call to the process-wide spelling thread in
//! [`apple::appkit`], which keeps `NSSpellChecker` on one stable thread.

pub mod apple;
