use std::{cell::RefMut, cmp};

use {
    encoding_rs::{CoderResult, Decoder, Encoding, UTF_8},
    grep_matcher::Matcher,
};

use crate::{
    line_buffer::{LineBuffer, alloc_error},
    searcher::{Config, ConfigError, Searcher, core::Core, glue::MultiLine},
    sink::{Sink, SinkError},
};

impl Searcher {
    /// Start a search over input that arrives in chunks and write the results
    /// to the given sink.
    ///
    /// The search has exactly the semantics of [`Searcher::search_reader`]:
    /// BOM sniffing and transcoding, binary detection, line-by-line or
    /// multi-line matching, context, line numbers, absolute byte offsets,
    /// passthru, inverted matching and stopping when the sink says so. Each
    /// chunk handed to [`PushSearch::push`] plays the part of one `read` of a
    /// reader, so a search over chunks produces the same sink calls as
    /// `search_reader` over a reader returning those same chunks. (Where binary
    /// detection is enabled, the sink calls depend on how the input is split
    /// into reads, for readers as well as for chunks.)
    ///
    /// A configuration or matcher that `search_reader` would reject is
    /// reported by the first call to `push` or `finish`.
    pub fn search_push<'s, M: Matcher, S: Sink>(
        &'s mut self,
        matcher: M,
        write_to: S,
    ) -> PushSearch<'s, M, S> {
        let searcher: &'s Searcher = self;
        let config_error = searcher.check_config(&matcher).err();
        let engine = if searcher.multi_line_with_matcher(&matcher) {
            let mut buf = searcher.multi_line_buffer.borrow_mut();
            buf.clear();
            Engine::Multi(Multi {
                searcher,
                matcher,
                sink: write_to,
                buf,
                started: false,
            })
        } else {
            let mut buf = searcher.line_buffer.borrow_mut();
            buf.clear();
            Engine::Lines(Lines {
                config: &searcher.config,
                core: Core::new(searcher, matcher, write_to, false),
                buf,
                phase: Phase::Fresh,
                fill: FillStart::default(),
            })
        };
        PushSearch {
            config_error,
            failed: false,
            decode: Decode::new(&searcher.config),
            engine,
        }
    }
}

/// An incremental search; `push` each chunk, then `finish`.
///
/// Created by [`Searcher::search_push`].
pub struct PushSearch<'s, M, S> {
    config_error: Option<ConfigError>,
    failed: bool,
    decode: Decode,
    engine: Engine<'s, M, S>,
}

// SAFETY: a `PushSearch` holds the searcher's exclusive borrow (`search_push`
// takes `&'s mut Searcher`), so the `RefCell` buffers behind its `RefMut`s and
// the `&'s Searcher` it keeps are reachable from the owner only; sending it
// sends the whole exclusive borrow. The sink only sees the `&Searcher` it is
// handed for the duration of a call. The matcher and the sink move with it,
// hence the bounds.
unsafe impl<'s, M: Send, S: Send> Send for PushSearch<'s, M, S> {}

impl<'s, M: Matcher, S: Sink> PushSearch<'s, M, S> {
    /// Searches the lines `chunk` completes; `Ok(false)` once the search is
    /// over (sink stopped, binary quit): feed nothing more and call `finish`.
    ///
    /// After an error the search is dead: further calls return `Ok(false)` and
    /// `finish` reports nothing, as `search_reader` reports nothing after an
    /// error.
    pub fn push(&mut self, chunk: &[u8]) -> Result<bool, S::Error> {
        if let Some(err) = self.config_error.take() {
            self.failed = true;
            return Err(S::Error::error_config(err));
        }
        if self.failed {
            return Ok(false);
        }
        let result = self.push_chunk(chunk);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn push_chunk(&mut self, chunk: &[u8]) -> Result<bool, S::Error> {
        let mut open = self.engine.start()?;
        if !open {
            return Ok(false);
        }
        for read in self.decode.feed(chunk) {
            if !open {
                break;
            }
            open = self.engine.read(read)?;
        }
        Ok(open)
    }

    /// Ends the input: searches what remains and reports the finish to the
    /// sink.
    pub fn finish(mut self) -> Result<(), S::Error> {
        if let Some(err) = self.config_error.take() {
            return Err(S::Error::error_config(err));
        }
        if self.failed {
            return Ok(());
        }
        match self.engine {
            Engine::Lines(mut lines) => {
                let mut open = lines.start()?;
                for read in self.decode.flush() {
                    if !open {
                        break;
                    }
                    open = lines.read(read)?;
                }
                if open {
                    lines.drive(&[], true)?;
                }
                lines.core.finish(
                    lines.buf.absolute_byte_offset(),
                    lines.buf.binary_byte_offset(),
                )
            }
            Engine::Multi(mut multi) => {
                multi.start()?;
                for read in self.decode.flush() {
                    multi.read(read)?;
                }
                multi.run()
            }
        }
    }
}

enum Engine<'s, M, S> {
    Lines(Lines<'s, M, S>),
    Multi(Multi<'s, M, S>),
}

impl<'s, M: Matcher, S: Sink> Engine<'s, M, S> {
    /// Begins the search if it has not begun. Returns false if the search is
    /// over.
    fn start(&mut self) -> Result<bool, S::Error> {
        match self {
            Engine::Lines(lines) => lines.start(),
            Engine::Multi(multi) => multi.start().map(|()| true),
        }
    }

    /// Searches one read. Returns false if the search is over.
    fn read(&mut self, data: &[u8]) -> Result<bool, S::Error> {
        match self {
            Engine::Lines(lines) => lines.read(data),
            Engine::Multi(multi) => multi.read(data).map(|()| true),
        }
    }
}

/// The phase of a line-by-line search.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    /// The sink has not been told that the search begins.
    Fresh,
    /// A fill of the line buffer is under way.
    Filling,
    /// Nothing more is read or searched.
    Over,
}

/// What `ReadByLine::fill` knows before it reads, kept for after it has.
#[derive(Clone, Copy, Debug, Default)]
struct FillStart {
    already_binary: bool,
    old_buf_len: usize,
    consumed: usize,
}

/// The line-by-line search: `ReadByLine` run as a state machine whose fills
/// wait for input instead of blocking on a reader.
struct Lines<'s, M, S> {
    config: &'s Config,
    core: Core<'s, M, S>,
    buf: RefMut<'s, LineBuffer>,
    phase: Phase,
    fill: FillStart,
}

impl<'s, M: Matcher, S: Sink> Lines<'s, M, S> {
    fn start(&mut self) -> Result<bool, S::Error> {
        if self.phase == Phase::Fresh {
            if self.core.begin()? {
                self.begin_fill();
                self.phase = Phase::Filling;
            } else {
                self.phase = Phase::Over;
            }
        }
        Ok(self.phase != Phase::Over)
    }

    fn read(&mut self, data: &[u8]) -> Result<bool, S::Error> {
        if data.is_empty() {
            return Ok(self.phase != Phase::Over);
        }
        self.drive(data, false)
    }

    /// Runs the search over `src`, which is one read of the input, or over the
    /// end of the input if `eof` is set. Returns false if the search is over.
    fn drive(&mut self, mut src: &[u8], eof: bool) -> Result<bool, S::Error> {
        loop {
            if self.phase == Phase::Over {
                return Ok(false);
            }
            let didread =
                match self.buf.push_fill(&mut src).map_err(S::Error::error_io)?
                {
                    Some(didread) => didread,
                    None if eof => self.buf.push_eof(),
                    None => return Ok(true),
                };
            if !self.end_fill(didread)? {
                self.phase = Phase::Over;
                return Ok(false);
            }
            if !self.core.match_by_line(self.buf.buffer())? {
                let consumed = self.core.pos();
                self.buf.consume(consumed);
                self.phase = Phase::Over;
                return Ok(false);
            }
            self.begin_fill();
        }
    }

    /// The part of `ReadByLine::fill` that precedes the reads.
    fn begin_fill(&mut self) {
        assert!(self.buf.buffer()[self.core.pos()..].is_empty());

        let already_binary = self.buf.binary_byte_offset().is_some();
        let old_buf_len = self.buf.buffer().len();
        let consumed = self.core.roll(self.buf.buffer());
        self.buf.consume(consumed);
        self.buf.roll();
        self.fill = FillStart { already_binary, old_buf_len, consumed };
    }

    /// The part of `ReadByLine::fill` that follows the reads. Returns whether
    /// the buffer is to be searched and the search to go on.
    fn end_fill(&mut self, didread: bool) -> Result<bool, S::Error> {
        let FillStart { already_binary, old_buf_len, consumed } = self.fill;
        if !already_binary
            && let Some(offset) = self.buf.binary_byte_offset()
            && !self.core.binary_data(offset)?
        {
            return Ok(false);
        }
        if !didread || self.should_binary_quit() {
            return Ok(false);
        }
        // If rolling the buffer didn't result in consuming anything and if
        // re-filling the buffer didn't add any bytes, then the only thing in
        // our buffer is leftover context, which we no longer need since there
        // is nothing left to search. So forcefully quit.
        if consumed == 0 && old_buf_len == self.buf.buffer().len() {
            self.buf.consume(old_buf_len);
            return Ok(false);
        }
        Ok(true)
    }

    fn should_binary_quit(&self) -> bool {
        self.buf.binary_byte_offset().is_some()
            && self.config.binary.quit_byte().is_some()
    }
}

/// The multi-line search, which has to hold all of its input before it can
/// start.
struct Multi<'s, M, S> {
    searcher: &'s Searcher,
    matcher: M,
    sink: S,
    buf: RefMut<'s, Vec<u8>>,
    started: bool,
}

impl<'s, M: Matcher, S: Sink> Multi<'s, M, S> {
    fn start(&mut self) -> Result<(), S::Error> {
        if !self.started {
            self.started = true;
            if self.searcher.config.heap_limit == Some(0) {
                return Err(S::Error::error_io(alloc_error(0)));
            }
        }
        Ok(())
    }

    fn read(&mut self, data: &[u8]) -> Result<(), S::Error> {
        self.buf.extend_from_slice(data);
        match self.searcher.config.heap_limit {
            Some(limit) if self.buf.len() >= limit => {
                Err(S::Error::error_io(alloc_error(limit)))
            }
            _ => Ok(()),
        }
    }

    fn run(self) -> Result<(), S::Error> {
        MultiLine::new(self.searcher, self.matcher, &self.buf, self.sink).run()
    }
}

/// The bytes at the start of the input that may be a byte-order mark.
#[derive(Clone, Copy, Debug)]
struct Peek {
    bytes: [u8; 3],
    len: usize,
}

/// A streaming equivalent of `encoding_rs_io::DecodeReaderBytes` as the
/// searcher configures it: the first three bytes are held back to detect a
/// byte-order mark, then the input is passed through or transcoded to UTF-8.
///
/// Each call hands out the reads the reader would have produced for the same
/// chunk: the (possibly stripped) byte-order mark as a read of its own, then
/// the rest of the chunk.
struct Decode {
    decoder: Option<Decoder>,
    /// Whether a byte-order mark may replace the decoder.
    detect: bool,
    /// Whether a byte-order mark is passed on rather than stripped.
    with_bom: bool,
    peek: Option<Peek>,
    head: Vec<u8>,
    body: Vec<u8>,
}

impl Decode {
    fn new(config: &Config) -> Decode {
        let encoding = config.encoding.as_ref().map(|e| e.0);
        Decode {
            decoder: encoding.map(|e| e.new_decoder_with_bom_removal()),
            detect: config.bom_sniffing,
            with_bom: !config.bom_sniffing,
            peek: Some(Peek { bytes: [0; 3], len: 0 }),
            head: vec![],
            body: vec![],
        }
    }

    fn feed<'a>(&'a mut self, chunk: &'a [u8]) -> [&'a [u8]; 2] {
        self.head.clear();
        let mut rest = chunk;
        if let Some(peek) = self.peek.as_mut() {
            let take = cmp::min(3 - peek.len, rest.len());
            peek.bytes[peek.len..peek.len + take]
                .copy_from_slice(&rest[..take]);
            peek.len += take;
            rest = &rest[take..];
            if peek.len < 3 {
                return [&[], &[]];
            }
            self.resolve();
        }
        let body: &[u8] = match self.decoder.as_mut() {
            Some(decoder) => {
                decode(decoder, rest, false, &mut self.body);
                &self.body
            }
            None => rest,
        };
        [&self.head, body]
    }

    fn flush(&mut self) -> [&[u8]; 2] {
        self.head.clear();
        self.resolve();
        let body: &[u8] = match self.decoder.as_mut() {
            Some(decoder) => {
                decode(decoder, &[], true, &mut self.body);
                &self.body
            }
            None => &[],
        };
        [&self.head, body]
    }

    /// Decides on the byte-order mark and puts what it leaves of the first
    /// bytes in `head`.
    fn resolve(&mut self) {
        let Some(Peek { bytes, len }) = self.peek.take() else {
            return;
        };
        if self.detect
            && len == 3
            && let Some((encoding, _)) = Encoding::for_bom(&bytes)
        {
            log::trace!("found byte-order mark (BOM) for encoding {encoding:?}");
            // A UTF-8 byte-order mark is stripped without transcoding.
            if encoding != UTF_8 {
                self.decoder = Some(encoding.new_decoder_with_bom_removal());
            }
        }
        let slice = bom_slice(&bytes[..len], self.with_bom);
        match self.decoder.as_mut() {
            Some(decoder) => {
                if !slice.is_empty() {
                    decode(decoder, slice, false, &mut self.head);
                }
            }
            None => self.head.extend_from_slice(slice),
        }
    }
}

/// The part of the first bytes that is passed on: all of them if a
/// byte-order mark is kept, otherwise all but a byte-order mark.
fn bom_slice(slice: &[u8], with_bom: bool) -> &[u8] {
    if with_bom || slice.len() <= 1 {
        slice
    } else if slice.starts_with(b"\xFF\xFE") || slice.starts_with(b"\xFE\xFF")
    {
        &slice[2..]
    } else if slice == b"\xEF\xBB\xBF" {
        &[]
    } else {
        slice
    }
}

/// Transcodes `src` to UTF-8 in `out`, replacing malformed sequences.
fn decode(decoder: &mut Decoder, mut src: &[u8], last: bool, out: &mut Vec<u8>) {
    out.clear();
    loop {
        let start = out.len();
        let room = decoder
            .max_utf8_buffer_length(src.len())
            .unwrap_or_else(|| src.len().saturating_mul(3).saturating_add(4));
        out.resize(start + room, 0);
        let (result, nin, nout, _) =
            decoder.decode_to_utf8(src, &mut out[start..], last);
        out.truncate(start + nout);
        src = &src[nin..];
        if result == CoderResult::InputEmpty {
            return;
        }
    }
}


