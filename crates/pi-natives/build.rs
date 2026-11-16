use std::{env, ffi::OsString, path::PathBuf, process::Command};

// Unify features with runtime dependencies shared by build scripts and macros.
use bitflags as _;
use crc32fast as _;
use data_encoding as _;
use either as _;
use fastrand as _;
use flate2 as _;
use foldhash as _;
use hashbrown as _;
use indexmap as _;
use libc as _;
use peg_runtime as _;
use rand_core as _;
use serde as _;
use serde_core as _;
use serde_json as _;
use simd_adler32 as _;
use zlib_rs as _;

fn main() {
	napi_build::setup();
	build_syntax_set();
	build_oauth_callback_helper();
}

#[path = "src/syntaxes/builder.rs"]
mod syntax_set_builder;

fn build_syntax_set() {
	let manifest_dir =
		PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"));
	let sources = manifest_dir.join("src/syntaxes");
	println!("cargo:rerun-if-changed={}", sources.display());
	let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR should be set"))
		.join("syntaxes.packdump");
	syntect::dumps::dump_to_uncompressed_file(&syntax_set_builder::build_syntax_set(), &output)
		.unwrap_or_else(|error| panic!("failed to write {}: {error}", output.display()));
	println!("cargo:rustc-env=OMP_SYNTAX_SET={}", output.display());
}

fn build_oauth_callback_helper() {
	let target_os = env::var("CARGO_CFG_TARGET_OS").expect("CARGO_CFG_TARGET_OS should be set");
	if target_os == "macos" {
		build_darwin_oauth_callback_helper();
	} else {
		build_oauth_callback_relay();
	}
}

fn build_oauth_callback_relay() {
	let name = String::from("omp-oauth-callback-relay");
	build_rust_helper(
		"src/oauth_callback/relay.rs",
		&["src/oauth_callback/publication.rs"],
		"omp_oauth_callback_relay",
		&name,
		"OMP_OAUTH_RELAY_BINARY",
	);
}

/// Compiles the standalone binary rooted at `root` (with the modules it
/// includes, `sources`) for the target with rustc directly, and exposes it to
/// the crate as `embed_variable` for embedding.
fn build_rust_helper(
	root: &str,
	sources: &[&str],
	crate_name: &str,
	name: &str,
	embed_variable: &str,
) {
	let manifest_dir =
		PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"));
	let target_os = env::var("CARGO_CFG_TARGET_OS").expect("CARGO_CFG_TARGET_OS should be set");
	let target = env::var("TARGET").expect("TARGET should be set");
	let rustc = env::var_os("RUSTC").unwrap_or_else(|| OsString::from("rustc"));
	let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR should be set")).join(name);

	for source in std::iter::once(root).chain(sources.iter().copied()) {
		println!("cargo:rerun-if-changed={}", manifest_dir.join(source).display());
	}
	println!("cargo:rerun-if-env-changed=RUSTC_LINKER");
	let target_linker_variable =
		format!("CARGO_TARGET_{}_LINKER", target.replace(['-', '.'], "_").to_ascii_uppercase());
	println!("cargo:rerun-if-env-changed={target_linker_variable}");

	let mut command = Command::new(rustc);
	command
		.current_dir(&manifest_dir)
		.arg("--crate-name")
		.arg(crate_name)
		.arg("--crate-type=bin")
		.arg("--edition=2024")
		.arg("--target")
		.arg(&target)
		.arg("-Copt-level=z")
		.arg("-Ccodegen-units=1")
		.arg("-Cpanic=abort")
		.arg("-Cstrip=symbols")
		.arg(manifest_dir.join(root))
		.arg("-o")
		.arg(&output);

	if let Some(encoded_flags) = env::var_os("CARGO_ENCODED_RUSTFLAGS") {
		for flag in encoded_flags
			.to_string_lossy()
			.split('\u{1f}')
			.filter(|flag| !flag.is_empty())
		{
			command.arg(flag);
		}
	}
	if let Some(linker) = target_linker(&target) {
		let mut linker_argument = OsString::from("linker=");
		linker_argument.push(linker);
		command.arg("-C").arg(linker_argument);
	}
	if target_os == "macos" {
		// Linkers sign arm64 ad hoc by default but not x86_64.
		command.arg("-Clink-arg=-Wl,-adhoc_codesign");
	}

	let result = command
		.output()
		.unwrap_or_else(|error| panic!("failed to invoke rustc for {name}: {error}"));
	assert!(
		result.status.success(),
		"failed to build {name} for {target} ({}):\nstdout:\n{}\nstderr:\n{}",
		result.status,
		String::from_utf8_lossy(&result.stdout),
		String::from_utf8_lossy(&result.stderr)
	);
	println!("cargo:rustc-env={embed_variable}={}", output.display());
}

#[path = "src/oauth_callback/darwin_compiler.rs"]
mod darwin_compiler;

fn build_darwin_oauth_callback_helper() {
	build_darwin_native_helper(
		"src/oauth_callback/darwin-helper.m",
		"omp-oauth-callback-darwin-helper",
		"OMP_OAUTH_DARWIN_HELPER",
		&["AppKit"],
		"12.0",
	);
}

fn build_darwin_native_helper(
	source: &str,
	name: &str,
	embed_variable: &str,
	frameworks: &[&str],
	minimum_macos: &str,
) {
	let manifest_dir =
		PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"));
	let source = manifest_dir.join(source);
	let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR should be set")).join(name);
	let architecture = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
		Ok("aarch64") => "arm64",
		Ok("x86_64") => "x86_64",
		Ok(architecture) => panic!("unsupported macOS helper architecture: {architecture}"),
		Err(error) => panic!("CARGO_CFG_TARGET_ARCH should be set: {error}"),
	};
	println!("cargo:rerun-if-changed={}", source.display());
	println!("cargo:rerun-if-changed=src/oauth_callback/darwin_compiler.rs");
	println!("cargo:rerun-if-env-changed=CC");
	println!("cargo:rerun-if-env-changed=SDKROOT");
	println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");

	let mut command = darwin_compiler::darwin_compiler_command(env::var_os("CC").as_deref());
	command.current_dir(&manifest_dir);
	if let Some(sdk_root) = darwin_compiler::darwin_sdk_root(env::var_os("SDKROOT").as_deref()) {
		command.arg("-isysroot").arg(sdk_root);
	}
	command
		.args([
			"-x",
			"objective-c",
			"-fobjc-arc",
			"-fblocks",
			"-fno-ident",
			"-Os",
			"-arch",
			architecture,
			"-Wl,-dead_strip",
			"-Wl,-adhoc_codesign",
		])
		.arg(format!("-mmacosx-version-min={minimum_macos}"));
	for framework in frameworks {
		command.arg("-framework").arg(framework);
	}
	let result = command
		.arg(&source)
		.arg("-o")
		.arg(&output)
		.output()
		.unwrap_or_else(|error| panic!("failed to invoke clang for {name}: {error}"));
	assert!(
		result.status.success(),
		"failed to build macOS {name} ({}):\nstdout:\n{}\nstderr:\n{}",
		result.status,
		String::from_utf8_lossy(&result.stdout),
		String::from_utf8_lossy(&result.stderr)
	);
	println!("cargo:rustc-env={embed_variable}={}", output.display());
}

fn target_linker(target: &str) -> Option<OsString> {
	let target_key = target.replace(['-', '.'], "_").to_ascii_uppercase();
	env::var_os(format!("CARGO_TARGET_{target_key}_LINKER")).or_else(|| env::var_os("RUSTC_LINKER"))
}
