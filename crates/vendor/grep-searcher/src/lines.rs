/*!
A collection of routines for performing operations on lines.
*/

use {
    bstr::ByteSlice,
    grep_matcher::{LineTerminator, Match},
};

/// An iterator over lines in a particular slice of bytes.
///
/// Line terminators are considered part of the line they terminate. All lines
/// yielded by the iterator are guaranteed to be non-empty.
///
/// `'b` refers to the lifetime of the underlying bytes.
#[derive(Debug)]
pub struct LineIter<'b> {
    bytes: &'b [u8],
    stepper: LineStep,
}

impl<'b> LineIter<'b> {
    /// Create a new line iterator that yields lines in the given bytes that
    /// are terminated by `line_term`.
    pub fn new(line_term: u8, bytes: &'b [u8]) -> LineIter<'b> {
        let stepper = LineStep::new(line_term, 0, bytes.len());
        LineIter { bytes, stepper }
    }
}

impl<'b> Iterator for LineIter<'b> {
    type Item = &'b [u8];

    fn next(&mut self) -> Option<&'b [u8]> {
        self.stepper.next_match(self.bytes).map(|m| &self.bytes[m])
    }
}

/// An explicit iterator over lines in a particular slice of bytes.
///
/// This iterator avoids borrowing the bytes themselves, and instead requires
/// callers to explicitly provide the bytes when moving through the iterator.
/// While not idiomatic, this provides a simple way of iterating over lines
/// that doesn't require borrowing the slice itself, which can be convenient.
///
/// Line terminators are considered part of the line they terminate. All lines
/// yielded by the iterator are guaranteed to be non-empty.
#[derive(Debug)]
pub struct LineStep {
    line_term: u8,
    pos: usize,
    end: usize,
}

impl LineStep {
    /// Create a new line iterator over the given range of bytes using the
    /// given line terminator.
    ///
    /// Callers should provide the actual bytes for each call to `next`. The
    /// same slice must be provided to each call.
    ///
    /// This panics if `start` is not less than or equal to `end`.
    pub fn new(line_term: u8, start: usize, end: usize) -> LineStep {
        LineStep { line_term, pos: start, end }
    }

    /// Return the start and end position of the next line in the given bytes.
    ///
    /// The caller must past exactly the same slice of bytes for each call to
    /// `next`.
    ///
    /// The range returned includes the line terminator. Ranges are always
    /// non-empty.
    pub fn next(&mut self, bytes: &[u8]) -> Option<(usize, usize)> {
        self.next_impl(bytes)
    }

    /// Like next, but returns a `Match` instead of a tuple.
    #[inline(always)]
    pub(crate) fn next_match(&mut self, bytes: &[u8]) -> Option<Match> {
        self.next_impl(bytes).map(|(s, e)| Match::new(s, e))
    }

    #[inline(always)]
    fn next_impl(&mut self, mut bytes: &[u8]) -> Option<(usize, usize)> {
        bytes = &bytes[..self.end];
        match bytes[self.pos..].find_byte(self.line_term) {
            None => {
                if self.pos < bytes.len() {
                    let m = (self.pos, bytes.len());
                    assert!(m.0 <= m.1);

                    self.pos = m.1;
                    Some(m)
                } else {
                    None
                }
            }
            Some(line_end) => {
                let m = (self.pos, self.pos + line_end + 1);
                assert!(m.0 <= m.1);

                self.pos = m.1;
                Some(m)
            }
        }
    }
}

/// Count the number of occurrences of `line_term` in `bytes`.
pub(crate) fn count(bytes: &[u8], line_term: u8) -> u64 {
    memchr::memchr_iter(line_term, bytes).count() as u64
}

/// Given a line that possibly ends with a terminator, return that line without
/// the terminator.
#[inline(always)]
pub(crate) fn without_terminator(
    bytes: &[u8],
    line_term: LineTerminator,
) -> &[u8] {
    let line_term = line_term.as_bytes();
    let start = bytes.len().saturating_sub(line_term.len());
    if bytes.get(start..) == Some(line_term) {
        return &bytes[..bytes.len() - line_term.len()];
    }
    bytes
}

/// Return the start and end offsets of the lines containing the given range
/// of bytes.
///
/// Line terminators are considered part of the line they terminate.
#[inline(always)]
pub(crate) fn locate(bytes: &[u8], line_term: u8, range: Match) -> Match {
    let line_start =
        bytes[..range.start()].rfind_byte(line_term).map_or(0, |i| i + 1);
    let line_end =
        if range.end() > line_start && bytes[range.end() - 1] == line_term {
            range.end()
        } else {
            bytes[range.end()..]
                .find_byte(line_term)
                .map_or(bytes.len(), |i| range.end() + i + 1)
        };
    Match::new(line_start, line_end)
}

/// Returns the minimal starting offset of the line that occurs `count` lines
/// before the last line in `bytes`.
///
/// Lines are terminated by `line_term`. If `count` is zero, then this returns
/// the starting offset of the last line in `bytes`.
///
/// If `bytes` ends with a line terminator, then the terminator itself is
/// considered part of the last line.
pub(crate) fn preceding(bytes: &[u8], line_term: u8, count: usize) -> usize {
    preceding_by_pos(bytes, bytes.len(), line_term, count)
}

/// Returns the minimal starting offset of the line that occurs `count` lines
/// before the line containing `pos`. Lines are terminated by `line_term`.
/// If `count` is zero, then this returns the starting offset of the line
/// containing `pos`.
///
/// If `pos` points just past a line terminator, then it is considered part of
/// the line that it terminates. For example, given `bytes = b"abc\nxyz\n"`
/// and `pos = 7`, `preceding(bytes, pos, b'\n', 0)` returns `4` (as does `pos
/// = 8`) and `preceding(bytes, pos, `b'\n', 1)` returns `0`.
fn preceding_by_pos(
    bytes: &[u8],
    mut pos: usize,
    line_term: u8,
    mut count: usize,
) -> usize {
    if pos == 0 {
        return 0;
    } else if bytes[pos - 1] == line_term {
        pos -= 1;
    }
    loop {
        match bytes[..pos].rfind_byte(line_term) {
            None => {
                return 0;
            }
            Some(i) => {
                if count == 0 {
                    return i + 1;
                } else if i == 0 {
                    return 0;
                }
                count -= 1;
                pos = i;
            }
        }
    }
}


