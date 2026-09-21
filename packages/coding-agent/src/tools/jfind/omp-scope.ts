/**
 * `omp://` search scope for `find`: the semantic cascade only walks
 * directories, while harness docs are virtual (no `sourcePath`). Materialize
 * the requested docs into a temp corpus, run the unchanged cascade over it,
 * then remap hits back to `omp://` URLs — the same materialize-and-remap
 * shape `grep` uses for archives.
 */
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { splitInternalUrlSel } from "@oh-my-pi/pi-tui/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { InternalUrlRouter } from "../../internal-urls/router";
import type { ResolveContext } from "../../internal-urls/types";
/** `omp://` prefix, case-insensitive. */
const OMP_SCOPE_RE = /^omp:\/\//i;
/** Root expansion (`omp://`, `omp://docs` plus a trailing slash), mirroring grep's `OMP_ROOT_URL_RE`. */
const OMP_ROOT_RE = /^omp:\/\/(?:\/?|docs\/?)$/i;

/** Whether `input` addresses harness docs instead of the filesystem. */
export function isOmpScopePath(input: string): boolean {
	return OMP_SCOPE_RE.test(input.trim());
}

export interface OmpScope {
	/** Temp corpus root: the cascade's `root`. */
	dir: string;
	/** Remove the temp corpus. Hits are remapped first, so callers run this in a `finally`. */
	cleanup: () => Promise<void>;
	/** Temp-root-relative `rel` (either separator) → canonical `omp://` URL. */
	toOmpRel: (rel: string) => string;
	/** Display form for headers: `omp://`, or `omp://<file>` for a single doc. */
	scopePath: string;
}
/** Canonical doc path for an `omp://` scope: normalized, traversal-free, without the handler's `docs/` prefix. */
function docRel(input: string): string {
	const withoutScheme = input.trim().replace(OMP_SCOPE_RE, "").replace(/^\/+/, "");
	const clean = withoutScheme.split(/[?#]/, 1)[0] ?? "";
	const normalized = path.posix.normalize(clean.replaceAll("\\", "/"));
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new ToolError("Path traversal (..) is not allowed in omp:// URLs");
	}
	if (normalized === "" || normalized === "." || normalized === "docs") return "";
	return normalized.startsWith("docs/") ? normalized.slice("docs/".length) : normalized;
}
/**
 * Materialize an `omp://` scope into a temp corpus of the embedded docs.
 * Root inputs expand to every doc (like grep's virtual `omp://` expansion);
 * anything else resolves one doc and rejects unknown names.
 */
export async function materializeOmpScope(rawInput: string, context?: ResolveContext): Promise<OmpScope> {
	const input = rawInput.trim();
	const router = InternalUrlRouter.instance();
	const dir = await mkdtemp(path.join(tmpdir(), "omp-find-"));
	const cleanup = async (): Promise<void> => {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	};
	const toOmpRel = (rel: string): string => `omp://${rel.replace(/\\/g, "/")}`;
	try {
		if (OMP_ROOT_RE.test(input)) {
			const completions = await router.complete("omp", "");
			const filenames = [...new Set((completions ?? []).map(completion => completion.value))].filter(
				filename => filename.length > 0,
			);
			if (filenames.length === 0) throw new ToolError("No documentation files found");
			for (const filename of filenames) {
				const doc = await router.resolve(`omp://${filename}`, context);
				await Bun.write(path.join(dir, filename), doc.content);
			}
			return { dir, cleanup, toOmpRel, scopePath: "omp://" };
		}
		// `find` searches whole files, so a trailing `:N-M` would silently be
		// ignored downstream — reject the same way a file scope would.
		const { sel } = splitInternalUrlSel(input);
		if (sel !== undefined) throw new ToolError(`Line-range selector requires a single file, not a scope: ${input}`);
		let content: string;
		try {
			content = (await router.resolve(input, context)).content;
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		const rel = docRel(input);
		if (rel.length === 0) throw new ToolError("No documentation files found");
		await Bun.write(path.join(dir, rel), content);
		return { dir, cleanup, toOmpRel, scopePath: `omp://${rel}` };
	} catch (error) {
		await cleanup();
		throw error;
	}
}
