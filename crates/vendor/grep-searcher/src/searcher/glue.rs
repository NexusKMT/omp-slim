use grep_matcher::Matcher;

use crate::{
    line_buffer::{DEFAULT_BUFFER_CAPACITY, LineBufferReader},
    lines::{self, LineStep},
    searcher::{Config, Range, Searcher, core::Core},
    sink::{Sink, SinkError},
};

#[derive(Debug)]
pub(crate) struct ReadByLine<'s, M, R, S> {
    config: &'s Config,
    core: Core<'s, M, S>,
    rdr: LineBufferReader<'s, R>,
}

impl<'s, M, R, S> ReadByLine<'s, M, R, S>
where
    M: Matcher,
    R: std::io::Read,
    S: Sink,
{
    pub(crate) fn new(
        searcher: &'s Searcher,
        matcher: M,
        read_from: LineBufferReader<'s, R>,
        write_to: S,
    ) -> ReadByLine<'s, M, R, S> {
        debug_assert!(!searcher.multi_line_with_matcher(&matcher));

        ReadByLine {
            config: &searcher.config,
            core: Core::new(searcher, matcher, write_to, false),
            rdr: read_from,
        }
    }

    pub(crate) fn run(mut self) -> Result<(), S::Error> {
        if self.core.begin()? {
            while self.fill()? {
                if !self.core.match_by_line(self.rdr.buffer())? {
                    self.consume_remaining();
                    break;
                }
            }
        }
        self.core.finish(
            self.rdr.absolute_byte_offset(),
            self.rdr.binary_byte_offset(),
        )
    }

    fn consume_remaining(&mut self) {
        let consumed = self.core.pos();
        self.rdr.consume(consumed);
    }

    fn fill(&mut self) -> Result<bool, S::Error> {
        assert!(self.rdr.buffer()[self.core.pos()..].is_empty());

        let already_binary = self.rdr.binary_byte_offset().is_some();
        let old_buf_len = self.rdr.buffer().len();
        let consumed = self.core.roll(self.rdr.buffer());
        self.rdr.consume(consumed);
        let didread = match self.rdr.fill() {
            Err(err) => return Err(S::Error::error_io(err)),
            Ok(didread) => didread,
        };
        if !already_binary {
            if let Some(offset) = self.rdr.binary_byte_offset() {
                if !self.core.binary_data(offset)? {
                    return Ok(false);
                }
            }
        }
        if !didread || self.should_binary_quit() {
            return Ok(false);
        }
        // If rolling the buffer didn't result in consuming anything and if
        // re-filling the buffer didn't add any bytes, then the only thing in
        // our buffer is leftover context, which we no longer need since there
        // is nothing left to search. So forcefully quit.
        if consumed == 0 && old_buf_len == self.rdr.buffer().len() {
            self.rdr.consume(old_buf_len);
            return Ok(false);
        }
        Ok(true)
    }

    fn should_binary_quit(&self) -> bool {
        self.rdr.binary_byte_offset().is_some()
            && self.config.binary.quit_byte().is_some()
    }
}

#[derive(Debug)]
pub(crate) struct SliceByLine<'s, M, S> {
    core: Core<'s, M, S>,
    slice: &'s [u8],
}

impl<'s, M: Matcher, S: Sink> SliceByLine<'s, M, S> {
    pub(crate) fn new(
        searcher: &'s Searcher,
        matcher: M,
        slice: &'s [u8],
        write_to: S,
    ) -> SliceByLine<'s, M, S> {
        debug_assert!(!searcher.multi_line_with_matcher(&matcher));

        SliceByLine {
            core: Core::new(searcher, matcher, write_to, true),
            slice,
        }
    }

    pub(crate) fn run(mut self) -> Result<(), S::Error> {
        if self.core.begin()? {
            let binary_upto =
                std::cmp::min(self.slice.len(), DEFAULT_BUFFER_CAPACITY);
            let binary_range = Range::new(0, binary_upto);
            if !self.core.detect_binary(self.slice, &binary_range)? {
                while !self.slice[self.core.pos()..].is_empty()
                    && self.core.match_by_line(self.slice)?
                {}
            }
        }
        let byte_count = self.byte_count();
        let binary_byte_offset = self.core.binary_byte_offset();
        self.core.finish(byte_count, binary_byte_offset)
    }

    fn byte_count(&mut self) -> u64 {
        match self.core.binary_byte_offset() {
            Some(offset) if offset < self.core.pos() as u64 => offset,
            _ => self.core.pos() as u64,
        }
    }
}

#[derive(Debug)]
pub(crate) struct MultiLine<'s, M, S> {
    config: &'s Config,
    core: Core<'s, M, S>,
    slice: &'s [u8],
    last_match: Option<Range>,
}

impl<'s, M: Matcher, S: Sink> MultiLine<'s, M, S> {
    pub(crate) fn new(
        searcher: &'s Searcher,
        matcher: M,
        slice: &'s [u8],
        write_to: S,
    ) -> MultiLine<'s, M, S> {
        debug_assert!(searcher.multi_line_with_matcher(&matcher));

        MultiLine {
            config: &searcher.config,
            core: Core::new(searcher, matcher, write_to, true),
            slice,
            last_match: None,
        }
    }

    pub(crate) fn run(mut self) -> Result<(), S::Error> {
        if self.core.begin()? {
            let binary_upto =
                std::cmp::min(self.slice.len(), DEFAULT_BUFFER_CAPACITY);
            let binary_range = Range::new(0, binary_upto);
            if !self.core.detect_binary(self.slice, &binary_range)? {
                let mut keepgoing = true;
                while !self.slice[self.core.pos()..].is_empty() && keepgoing {
                    keepgoing = self.sink()?;
                }
                if keepgoing {
                    keepgoing = match self.last_match.take() {
                        None => true,
                        Some(last_match) => {
                            if self.sink_context(&last_match)? {
                                self.sink_matched(&last_match)?;
                            }
                            true
                        }
                    };
                }
                // Take care of any remaining context after the last match.
                if keepgoing {
                    if self.config.passthru {
                        self.core.other_context_by_line(
                            self.slice,
                            self.slice.len(),
                        )?;
                    } else {
                        self.core.after_context_by_line(
                            self.slice,
                            self.slice.len(),
                        )?;
                    }
                }
            }
        }
        let byte_count = self.byte_count();
        let binary_byte_offset = self.core.binary_byte_offset();
        self.core.finish(byte_count, binary_byte_offset)
    }

    fn sink(&mut self) -> Result<bool, S::Error> {
        if self.config.invert_match {
            return self.sink_matched_inverted();
        }
        let mat = match self.find()? {
            Some(range) => range,
            None => {
                self.core.set_pos(self.slice.len());
                return Ok(true);
            }
        };
        self.advance(&mat);

        let line =
            lines::locate(self.slice, self.config.line_term.as_byte(), mat);
        // We delay sinking the match to make sure we group adjacent matches
        // together in a single sink. Adjacent matches are distinct matches
        // that start and end on the same line, respectively. This guarantees
        // that a single line is never sinked more than once.
        match self.last_match.take() {
            None => {
                self.last_match = Some(line);
                Ok(true)
            }
            Some(last_match) => {
                // If the lines in the previous match overlap with the lines
                // in this match, then simply grow the match and move on. This
                // happens when the next match begins on the same line that the
                // last match ends on.
                //
                // Note that we do not technically require strict overlap here.
                // Instead, we only require that the lines are adjacent. This
                // provides larger blocks of lines to the printer, and results
                // in overall better behavior with respect to how replacements
                // are handled.
                //
                // See: https://github.com/BurntSushi/ripgrep/issues/1311
                // And also the associated commit fixing #1311.
                if last_match.end() >= line.start() {
                    self.last_match = Some(last_match.with_end(line.end()));
                    Ok(true)
                } else {
                    self.last_match = Some(line);
                    if !self.sink_context(&last_match)? {
                        return Ok(false);
                    }
                    self.sink_matched(&last_match)
                }
            }
        }
    }

    fn sink_matched_inverted(&mut self) -> Result<bool, S::Error> {
        assert!(self.config.invert_match);

        let invert_match = match self.find()? {
            None => {
                let range = Range::new(self.core.pos(), self.slice.len());
                self.core.set_pos(range.end());
                range
            }
            Some(mat) => {
                let line = lines::locate(
                    self.slice,
                    self.config.line_term.as_byte(),
                    mat,
                );
                let range = Range::new(self.core.pos(), line.start());
                self.advance(&line);
                range
            }
        };
        if invert_match.is_empty() {
            return Ok(true);
        }
        if !self.sink_context(&invert_match)? {
            return Ok(false);
        }
        let mut stepper = LineStep::new(
            self.config.line_term.as_byte(),
            invert_match.start(),
            invert_match.end(),
        );
        while let Some(line) = stepper.next_match(self.slice) {
            if !self.sink_matched(&line)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn sink_matched(&mut self, range: &Range) -> Result<bool, S::Error> {
        if range.is_empty() {
            // The only way we can produce an empty line for a match is if we
            // match the position immediately following the last byte that we
            // search, and where that last byte is also the line terminator. We
            // never want to report that match, and we know we're done at that
            // point anyway, so stop the search.
            return Ok(false);
        }
        self.core.matched(self.slice, range)
    }

    fn sink_context(&mut self, range: &Range) -> Result<bool, S::Error> {
        if self.config.passthru {
            if !self.core.other_context_by_line(self.slice, range.start())? {
                return Ok(false);
            }
        } else {
            if !self.core.after_context_by_line(self.slice, range.start())? {
                return Ok(false);
            }
            if !self.core.before_context_by_line(self.slice, range.start())? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn find(&mut self) -> Result<Option<Range>, S::Error> {
        self.core
            .find(&self.slice[self.core.pos()..])
            .map(|m| m.map(|m| m.offset(self.core.pos())))
    }

    /// Advance the search position based on the previous match.
    ///
    /// If the previous match is zero width, then this advances the search
    /// position one byte past the end of the match.
    fn advance(&mut self, range: &Range) {
        self.core.set_pos(range.end());
        if range.is_empty() && self.core.pos() < self.slice.len() {
            let newpos = self.core.pos() + 1;
            self.core.set_pos(newpos);
        }
    }

    fn byte_count(&mut self) -> u64 {
        match self.core.binary_byte_offset() {
            Some(offset) if offset < self.core.pos() as u64 => offset,
            _ => self.core.pos() as u64,
        }
    }
}


