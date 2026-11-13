//! Syntax highlighting using syntect.
//!
//! Provides ANSI-colored output for code blocks. Takes theme colors as input
//! and maps syntect scopes to 11 semantic categories:
//! - comment, keyword, function, variable, string, number, type, operator,
//!   punctuation, inserted, deleted

use std::{
	cell::RefCell,
	collections::{HashMap, HashSet},
	sync::LazyLock,
};

use napi::{JsString, Result};
use napi_derive::napi;
use pi_shell::rayon_global_pool_available;
use rayon::prelude::*;
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};

use crate::{
	js::{self, InlineStr},
	task,
};

/// One theme colour: an ANSI escape sequence such as `\x1b[38;2;255;0;0m`.
///
/// Decoded inline, so a whole palette crosses the boundary without touching
/// the heap. The longest sequence a theme can produce sets attributes plus
/// truecolor foreground and background — `\x1b[1;3;4;38;2;255;255;255;48;2;
/// 255;255;255m`, 42 bytes — which the 47 usable bytes cover.
pub type Color = InlineStr<48>;

static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(|| {
	syntect::dumps::from_uncompressed_data(include_bytes!(env!("OMP_SYNTAX_SET")))
		.expect("bundled syntax set should match the syntect build")
});
static SCOPE_MATCHERS: LazyLock<ScopeMatchers> = LazyLock::new(ScopeMatchers::new);

// Thread-local cache for scope -> color index lookups
thread_local! {
	static SCOPE_COLOR_CACHE: RefCell<HashMap<Scope, usize>> = RefCell::new(HashMap::with_capacity(256));
}

/// Pre-compiled scope patterns for fast matching.
struct ScopeMatchers {
	// Comment (index 0)
	comment: Scope,

	// String (index 4). Not `meta.string`: it spans a whole string,
	// interpolations included, and grammars clear only `string.*` inside
	// `{x}`, `#{x}` or `$(x)`.
	string:             Scope,
	constant_character: Scope,

	// Number (index 5)
	constant_numeric: Scope,
	constant_integer: Scope,
	constant:         Scope,

	// Keyword (index 1)
	keyword:          Scope,
	storage_type:     Scope,
	storage_modifier: Scope,

	// Function (index 2)
	entity_name_function: Scope,
	support_function:     Scope,
	meta_function_call:   Scope,
	variable_function:    Scope,

	// Type (index 6)
	entity_name_type:      Scope,
	support_type:          Scope,
	support_class:         Scope,
	entity_name_class:     Scope,
	entity_name_struct:    Scope,
	entity_name_enum:      Scope,
	entity_name_interface: Scope,
	entity_name_trait:     Scope,

	// Operator (index 7)
	keyword_operator:     Scope,
	punctuation_accessor: Scope,

	// Punctuation (index 8)
	punctuation: Scope,

	// Variable (index 3)
	variable:    Scope,
	entity_name: Scope,
	meta_path:   Scope,

	// Diff (indices 9, 10)
	markup_inserted:  Scope,
	markup_deleted:   Scope,
	meta_diff_header: Scope,
	meta_diff_range:  Scope,
}

impl ScopeMatchers {
	fn new() -> Self {
		Self {
			comment:               Scope::new("comment").unwrap(),
			string:                Scope::new("string").unwrap(),
			constant_character:    Scope::new("constant.character").unwrap(),
			constant_numeric:      Scope::new("constant.numeric").unwrap(),
			constant_integer:      Scope::new("constant.integer").unwrap(),
			constant:              Scope::new("constant").unwrap(),
			keyword:               Scope::new("keyword").unwrap(),
			storage_type:          Scope::new("storage.type").unwrap(),
			storage_modifier:      Scope::new("storage.modifier").unwrap(),
			entity_name_function:  Scope::new("entity.name.function").unwrap(),
			support_function:      Scope::new("support.function").unwrap(),
			meta_function_call:    Scope::new("meta.function-call").unwrap(),
			variable_function:     Scope::new("variable.function").unwrap(),
			entity_name_type:      Scope::new("entity.name.type").unwrap(),
			support_type:          Scope::new("support.type").unwrap(),
			support_class:         Scope::new("support.class").unwrap(),
			entity_name_class:     Scope::new("entity.name.class").unwrap(),
			entity_name_struct:    Scope::new("entity.name.struct").unwrap(),
			entity_name_enum:      Scope::new("entity.name.enum").unwrap(),
			entity_name_interface: Scope::new("entity.name.interface").unwrap(),
			entity_name_trait:     Scope::new("entity.name.trait").unwrap(),
			keyword_operator:      Scope::new("keyword.operator").unwrap(),
			punctuation_accessor:  Scope::new("punctuation.accessor").unwrap(),
			punctuation:           Scope::new("punctuation").unwrap(),
			variable:              Scope::new("variable").unwrap(),
			entity_name:           Scope::new("entity.name").unwrap(),
			meta_path:             Scope::new("meta.path").unwrap(),
			markup_inserted:       Scope::new("markup.inserted").unwrap(),
			markup_deleted:        Scope::new("markup.deleted").unwrap(),
			meta_diff_header:      Scope::new("meta.diff.header").unwrap(),
			meta_diff_range:       Scope::new("meta.diff.range").unwrap(),
		}
	}
}

/// Theme colors for syntax highlighting.
/// Each color is an ANSI escape sequence (e.g., "\x1b[38;2;255;0;0m").
#[derive(Debug)]
#[napi(object)]
pub struct HighlightColors {
	/// ANSI color for comments.
	#[napi(ts_type = "string")]
	pub comment:     Color,
	/// ANSI color for keywords.
	#[napi(ts_type = "string")]
	pub keyword:     Color,
	/// ANSI color for function names.
	#[napi(ts_type = "string")]
	pub function:    Color,
	/// ANSI color for variables and identifiers.
	#[napi(ts_type = "string")]
	pub variable:    Color,
	/// ANSI color for string literals.
	#[napi(ts_type = "string")]
	pub string:      Color,
	/// ANSI color for numeric literals.
	#[napi(ts_type = "string")]
	pub number:      Color,
	/// ANSI color for type identifiers.
	#[napi(ts_type = "string")]
	pub r#type:      Color,
	/// ANSI color for operators.
	#[napi(ts_type = "string")]
	pub operator:    Color,
	/// ANSI color for punctuation tokens.
	#[napi(ts_type = "string")]
	pub punctuation: Color,
	/// ANSI color for diff inserted lines.
	#[napi(ts_type = "string")]
	pub inserted:    Option<Color>,
	/// ANSI color for diff deleted lines.
	#[napi(ts_type = "string")]
	pub deleted:     Option<Color>,
}

/// Language alias mappings: (aliases, target syntax name).
/// Used for languages not in syntect's default set or with non-standard names.
const LANG_ALIASES: &[(&[&str], &str)] = &[
	(&["ts", "mts", "cts", "typescript"], "TypeScript"),
	(&["tsx"], "TypeScriptReact"),
	(&["js", "jsx", "javascript", "mjs", "cjs"], "JavaScript"),
	(&["py", "python"], "Python"),
	(&["rb", "ruby"], "Ruby"),
	(&["jl", "julia"], "Julia"),
	(&["nix"], "Nix"),
	(&["mermaid", "mmd"], "Mermaid"),
	(&["zig", "zon"], "Zig"),
	(&["rs", "rust"], "Rust"),
	(&["go", "golang"], "Go"),
	(&["java"], "Java"),
	(&["kt", "kts", "kotlin"], "Kotlin"),
	(&["swift"], "Swift"),
	(&["c"], "C"),
	(&["cpp", "cc", "cxx", "c++", "hpp", "hxx", "hh"], "C++"),
	(&["cs", "csharp"], "C#"),
	(&["php"], "PHP"),
	(&["sh", "bash", "zsh", "shell"], "Bash"),
	(&["ps1", "powershell", "pwsh"], "PowerShell"),
	(&["html", "htm", "vue", "svelte"], "HTML"),
	(&["astro"], "Astro"),
	(&["css"], "CSS"),
	(&["scss"], "SCSS"),
	(&["sass"], "Sass"),
	// No licensed Less grammar loads in syntect (the maintained one uses
	// `extends`); SCSS shares its nesting, `//` comments and most syntax.
	(&["less"], "SCSS"),
	(&["json"], "JSON"),
	(&["yaml", "yml"], "YAML"),
	(&["toml"], "TOML"),
	(&["xml"], "XML"),
	(&["md", "markdown"], "Markdown"),
	(&["sql"], "SQL"),
	(&["lua"], "Lua"),
	(&["r"], "R"),
	(&["scala"], "Scala"),
	(&["clj", "clojure"], "Clojure"),
	(&["el", "elisp", "emacs-lisp", "emacslisp"], "Lisp"),
	(&["ex", "exs", "elixir"], "Elixir"),
	(&["erl", "erlang"], "Erlang"),
	(&["hs", "haskell"], "Haskell"),
	(&["ml", "ocaml"], "OCaml"),
	(&["vim"], "VimL"),
	(&["graphql", "gql"], "GraphQL"),
	(&["proto", "protobuf"], "Protocol Buffer"),
	(&["tf", "hcl", "terraform"], "Terraform"),
	(&["dockerfile", "docker", "containerfile"], "Dockerfile"),
	(&["makefile", "make", "just", "justfile"], "Makefile"),
	(&["cmake", "cmakelists"], "CMake"),
	(&["ini", "cfg", "conf", "config"], "INI"),
	(&["diff", "patch"], "Diff"),
	(&["gitignore", "gitattributes", "gitmodules"], "Git Ignore"),
];

/// Find syntax name from alias table using case-insensitive comparison.
#[inline]
fn find_alias(lang: &str) -> Option<&'static str> {
	LANG_ALIASES
		.iter()
		.find(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
		.map(|(_, target)| *target)
}

/// Compute the color index for a single scope (uncached).
#[inline]
fn compute_scope_color(s: Scope) -> usize {
	let m = &*SCOPE_MATCHERS;

	// Comment (index 0)
	if m.comment.is_prefix_of(s) {
		return 0;
	}

	// Diff inserted (index 9)
	if m.markup_inserted.is_prefix_of(s) {
		return 9;
	}

	// Diff deleted (index 10)
	if m.markup_deleted.is_prefix_of(s) {
		return 10;
	}

	// Diff header/range -> keyword (index 1)
	if m.meta_diff_header.is_prefix_of(s) || m.meta_diff_range.is_prefix_of(s) {
		return 1;
	}

	// String (index 4)
	if m.string.is_prefix_of(s) || m.constant_character.is_prefix_of(s) {
		return 4;
	}

	// Number (index 5)
	if m.constant_numeric.is_prefix_of(s) || m.constant_integer.is_prefix_of(s) {
		return 5;
	}

	// Keyword (index 1)
	if m.keyword.is_prefix_of(s)
		|| m.storage_type.is_prefix_of(s)
		|| m.storage_modifier.is_prefix_of(s)
	{
		return 1;
	}

	// Function (index 2)
	if m.entity_name_function.is_prefix_of(s)
		|| m.support_function.is_prefix_of(s)
		|| m.meta_function_call.is_prefix_of(s)
		|| m.variable_function.is_prefix_of(s)
	{
		return 2;
	}

	// Type (index 6)
	if m.entity_name_type.is_prefix_of(s)
		|| m.support_type.is_prefix_of(s)
		|| m.support_class.is_prefix_of(s)
		|| m.entity_name_class.is_prefix_of(s)
		|| m.entity_name_struct.is_prefix_of(s)
		|| m.entity_name_enum.is_prefix_of(s)
		|| m.entity_name_interface.is_prefix_of(s)
		|| m.entity_name_trait.is_prefix_of(s)
	{
		return 6;
	}

	// Operator (index 7)
	if m.keyword_operator.is_prefix_of(s) || m.punctuation_accessor.is_prefix_of(s) {
		return 7;
	}

	// Punctuation (index 8)
	if m.punctuation.is_prefix_of(s) {
		return 8;
	}

	// Variable (index 3)
	if m.variable.is_prefix_of(s) || m.entity_name.is_prefix_of(s) || m.meta_path.is_prefix_of(s) {
		return 3;
	}

	// Generic constant -> number (index 5)
	if m.constant.is_prefix_of(s) {
		return 5;
	}

	// No match
	usize::MAX
}

/// Determine the semantic color category from a scope stack.
/// Uses per-scope caching to avoid repeated prefix checks.
#[inline]
fn scope_to_color_index(scope: &ScopeStack) -> usize {
	SCOPE_COLOR_CACHE.with(|cache| {
		let mut cache = cache.borrow_mut();

		// Walk from innermost to outermost scope
		for s in scope.as_slice().iter().rev() {
			let color_idx = *cache.entry(*s).or_insert_with(|| compute_scope_color(*s));
			if color_idx != usize::MAX {
				return color_idx;
			}
		}

		usize::MAX
	})
}

/// Find the appropriate syntax for a language name.
fn find_syntax<'a>(ss: &'a SyntaxSet, lang: &str) -> Option<&'a SyntaxReference> {
	// Direct name/token match (syntect APIs are case-insensitive)
	if let Some(syn) = ss.find_syntax_by_token(lang) {
		return Some(syn);
	}

	// Extension-based match
	if let Some(syn) = ss.find_syntax_by_extension(lang) {
		return Some(syn);
	}

	// Alias lookup for languages not in syntect's default set
	let alias = find_alias(lang)?;

	ss.find_syntax_by_name(alias)
		.or_else(|| ss.find_syntax_by_token(alias))
}

/// Highlight code and return ANSI-colored lines.
///
/// # Arguments
/// * `code` - The source code to highlight
/// * `lang` - Language identifier (e.g., "rust", "typescript", "python")
/// * `colors` - Theme colors as ANSI escape sequences
///
/// # Returns
/// Highlighted code with ANSI color codes, or the original code if highlighting
/// fails.
#[napi]
pub fn highlight_code(
	code: JsString,
	lang: Option<JsString>,
	colors: HighlightColors,
) -> Result<String> {
	let code = js::utf8(code)?;
	let lang = lang.map(js::utf8).transpose()?;
	Ok(highlight_code_impl(&code, lang.as_deref(), &colors))
}

/// Color palette as array for quick indexing.
fn palette(colors: &HighlightColors) -> [&str; 11] {
	[
		&*colors.comment,                         // 0
		&*colors.keyword,                         // 1
		&*colors.function,                        // 2
		&*colors.variable,                        // 3
		&*colors.string,                          // 4
		&*colors.number,                          // 5
		&*colors.r#type,                          // 6
		&*colors.operator,                        // 7
		&*colors.punctuation,                     // 8
		colors.inserted.as_deref().unwrap_or(""), // 9
		colors.deleted.as_deref().unwrap_or(""),  // 10
	]
}

fn highlight_code_impl(code: &str, lang: Option<&str>, colors: &HighlightColors) -> String {
	let Some(lang) = lang else {
		return code.to_owned();
	};
	let ss = &*SYNTAX_SET;
	let Some(syntax) = find_syntax(ss, lang) else {
		return code.to_owned();
	};

	let mut parse_state = ParseState::new(syntax);
	let mut scope_stack = ScopeStack::new();
	let mut result = String::with_capacity(code.len() * 2);
	highlight_into(code, ss, &mut parse_state, &mut scope_stack, &palette(colors), &mut result);
	result
}

/// Highlight `code` line by line, advancing `parse_state`/`scope_stack` and
/// appending ANSI-colored output to `result`. Because syntect parses strictly
/// forward, feeding a text in chunks of whole lines produces byte-identical
/// output to feeding it at once — the contract [`HighlightStream`] relies on.
fn highlight_into(
	code: &str,
	ss: &SyntaxSet,
	parse_state: &mut ParseState,
	scope_stack: &mut ScopeStack,
	palette: &[&str; 11],
	result: &mut String,
) {
	for line in syntect::util::LinesWithEndings::from(code) {
		let Ok(ops) = parse_state.parse_line(line, ss) else {
			// Parse error - append unhighlighted line and continue
			result.push_str(line);
			continue;
		};

		let mut prev_end = 0;
		for (offset, op) in ops {
			let offset = offset.min(line.len());

			// Output text BEFORE this operation using current scope
			if offset > prev_end {
				let text = &line[prev_end..offset];
				let color_idx = scope_to_color_index(scope_stack);

				if color_idx < palette.len() && !palette[color_idx].is_empty() {
					result.push_str(palette[color_idx]);
					result.push_str(text);
					result.push_str("\x1b[39m");
				} else {
					result.push_str(text);
				}
			}
			prev_end = offset;

			// Apply the operation for the NEXT segment, `Clear`/`Restore`
			// included: a grammar's `clear_scopes` (string interpolation)
			// hides the enclosing string from the code inside. A malformed op
			// sequence only loses styling.
			let _ = scope_stack.apply(&op);
		}

		// Output remaining text with current scope
		if prev_end < line.len() {
			let text = &line[prev_end..];
			let color_idx = scope_to_color_index(scope_stack);

			if color_idx < palette.len() && !palette[color_idx].is_empty() {
				result.push_str(palette[color_idx]);
				result.push_str(text);
				result.push_str("\x1b[39m");
			} else {
				result.push_str(text);
			}
		}
	}
}

/// Shared TypeScript warm source; a macro so `concat!` can extend it for TSX.
macro_rules! warm_typescript {
	() => {
		r#"import { readFile } from "node:fs/promises";
import type { Foo } from "./foo";
export * from "./bar";
/** Doc comment. */
// line comment
export interface Options<T extends object = {}> { readonly name?: string; items: T[]; [key: string]: unknown }
export type Mode = "a" | "b" | `c-${string}`;
enum Color { Red = 1, Green = "g" }
declare module "x" {}
@decorator()
export abstract class Service<T> extends Base implements Api {
	#count = 0;
	private static readonly map = new Map<string, number>();
	constructor(private readonly dep: Dep) { super(); }
	get value(): number { return this.#count; }
	async *run(this: Service<T>, ...args: unknown[]): AsyncGenerator<T> {
		const { a, b: [c, ...d] } = obj ?? {};
		let re = /ab+c/gi, n = 0x1f + 1_000n + 1.5e3;
		for await (const x of stream) { yield x as T; }
		try { await fn?.(a!, <T>b); } catch (err) { throw new Error(`bad ${err}`); } finally { n++; }
		switch (a) { case 1: break; default: return; }
		const arrow = async <U,>(u: U): Promise<U> => u satisfies U;
		label: while (n-- > 0 && !done || x instanceof Y) continue label;
		return typeof x === "string" ? x : void 0;
	}
}
function f(this: void, x?: number, cb: (e: Error) => void = () => {}): asserts x is number {}
"#
	};
}

/// Representative sources parsed by [`warm_highlighter`].
///
/// syntect compiles each pattern's regex lazily, the first time the parser
/// enters that pattern's context. For the large TypeScript/TSX grammars that
/// first parse costs ~250ms, paid on the JS thread by whichever render first
/// shows such a block. Parsing constructs that enter the common contexts
/// moves that compilation to the worker pool; compiled regexes live in the
/// shared syntax set, so later parses on any thread reuse them.
const WARM_SNIPPETS: &[(&str, &str)] = &[
	("ts", warm_typescript!()),
	(
		"tsx",
		concat!(
			warm_typescript!(),
			r#"export const C = (p: Props) => <div className="x" onClick={() => go(p.id)}>{p.children}<Foo<T> bar /></div>;
"#
		),
	),
	(
		"js",
		r"import x from 'y';
export default async function f(a = 1, ...b) { const { c } = a; return `t${c}` ?? null; }
class A { #p = 1; static m() { return /re/g.test(this.#p); } }
",
	),
	(
		"bash",
		r#"#!/usr/bin/env bash
# comment
set -euo pipefail
export FOO="bar $HOME ${VAR:-default} $(date +%s)"
for f in *.ts; do echo "$f" | grep -E 'x+' >> out.txt 2>&1; done
if [[ -n "$1" && $# -gt 0 ]]; then cd "$(dirname "$0")" || exit 1; fi
case "$x" in a|b) echo 'one' ;; *) printf '%s\n' "$x" ;; esac
fn() { local arr=(1 2 3); echo "${arr[@]}" $((1 + 2)); }
cat <<EOF
heredoc $x
EOF
git log --oneline -n 5 && bun test || true
"#,
	),
	(
		"python",
		r#"import os
from typing import Any
@dataclass
class A(Base):
    """Doc."""
    def f(self, x: int = 1, *args, **kw) -> str:
        # comment
        s = f"v {x!r:>4}" + 'y' + r"\d" + b"z"
        return [i for i in range(10) if i % 2] or {k: v for k, v in kw.items()}
async def g(): await h(); lambda y: y ** 2
"#,
	),
	(
		"rust",
		r##"use std::collections::HashMap;
/// Doc
#[derive(Debug, Clone)]
pub struct S<'a, T: Clone> { field: &'a [T], n: u32 }
impl<T> Trait for S<'_, T> where T: Send {
    fn f(&mut self, x: Option<i64>) -> Result<(), Box<dyn Error>> {
        let v = vec![1, 2]; let s = "str\n"; let c = 'c'; let r = r#"raw"#;
        match x { Some(n) if n > 0 => println!("{n}"), _ => {} }
        Ok(())
    }
}
"##,
	),
	(
		"markdown",
		r"# Title
Some **bold**, _italic_, `code`, [link](http://x.y) and ![img](a.png).
> quote
- item
  1. nested
| a | b |
|---|---|
| 1 | 2 |
```ts
const x = 1;
```
---
",
	),
];

/// Warm syntax grammars, scope matchers, and the regexes of commonly
/// highlighted languages on the native worker pool.
#[napi]
pub fn warm_highlighter() -> task::Promise<()> {
	task::blocking("highlight.warm", (), move |_| {
		let ss = &*SYNTAX_SET;
		LazyLock::force(&SCOPE_MATCHERS);
		let warm = |&(lang, code): &(&str, &str)| {
			let Some(syntax) = find_syntax(ss, lang) else {
				return;
			};
			let mut parse_state = ParseState::new(syntax);
			for line in syntect::util::LinesWithEndings::from(code) {
				if parse_state.parse_line(line, ss).is_err() {
					break;
				}
			}
		};
		if rayon_global_pool_available() {
			WARM_SNIPPETS.par_iter().for_each(warm);
		} else {
			WARM_SNIPPETS.iter().for_each(warm);
		}
		Ok(())
	})
}

/// Stateful incremental syntax highlighter for streamed code.
///
/// Carries syntect parser state across [`HighlightStream::push`] calls so
/// chunked highlighting of a growing buffer is byte-identical to highlighting
/// the concatenated text in one call. Feed newline-terminated complete lines;
/// only the final push may omit the trailing newline. An unresolved language
/// echoes input unchanged.
#[napi]
pub struct HighlightStream {
	state:  Option<(ParseState, ScopeStack)>,
	colors: HighlightColors,
}

#[napi]
impl HighlightStream {
	/// Create a stream for `lang`; an unknown language yields a passthrough.
	#[napi(constructor)]
	pub fn new(lang: Option<JsString>, colors: HighlightColors) -> Result<Self> {
		let lang = lang.map(js::utf8).transpose()?;
		let state = lang
			.as_deref()
			.and_then(|l| find_syntax(&SYNTAX_SET, l))
			.map(|syntax| (ParseState::new(syntax), ScopeStack::new()));
		Ok(Self { state, colors })
	}

	/// Whether the language resolved to a grammar; `false` means passthrough.
	#[napi(getter)]
	pub const fn supported(&self) -> bool {
		self.state.is_some()
	}

	/// Highlight the next chunk and advance parser state.
	#[napi]
	pub fn push(&mut self, chunk: JsString) -> Result<String> {
		let chunk = js::utf8(chunk)?;
		let Some((parse_state, scope_stack)) = self.state.as_mut() else {
			return Ok(chunk.to_owned());
		};
		let mut result = String::with_capacity(chunk.len() * 2);
		highlight_into(
			&chunk,
			&SYNTAX_SET,
			parse_state,
			scope_stack,
			&palette(&self.colors),
			&mut result,
		);
		Ok(result)
	}
}

/// Check if a language resolves to a grammar (by name, extension or alias),
/// i.e. whether `highlightCode` colors it rather than echoing it.
#[napi]
pub fn supports_language(lang: JsString) -> Result<bool> {
	Ok(supports_language_impl(&js::utf8(lang)?))
}

fn supports_language_impl(lang: &str) -> bool {
	find_syntax(&SYNTAX_SET, lang).is_some()
}

/// Get list of supported languages.
#[napi]
pub fn get_supported_languages() -> Vec<String> {
	let ss = &*SYNTAX_SET;
	let mut seen = HashSet::new();
	ss.syntaxes()
		.iter()
		.filter(|syntax| seen.insert(syntax.name.as_str()))
		.map(|syntax| syntax.name.clone())
		.collect()
}




