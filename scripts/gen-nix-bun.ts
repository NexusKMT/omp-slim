#!/usr/bin/env bun

import * as path from "node:path";
import { $ } from "bun";
import { $which } from "../packages/utils/src/which";

const repoRoot = path.join(import.meta.dir, "..");

/** Regenerate the checked-in Bun dependency expression with the pinned bun2nix input. */
export async function generateNixBunDeps(): Promise<void> {
	const bun2nix = $which("bun2nix");
	if (bun2nix) {
		await $`${bun2nix} -l bun.lock -c ../ -o nix/bun.nix`.cwd(repoRoot);
		return;
	}

	const nix = $which("nix");
	if (!nix) {
		throw new Error("Generating nix/bun.nix requires bun2nix from `nix develop`, or Nix to enter that shell.");
	}

	await $`${nix} --extra-experimental-features ${"nix-command flakes"} --accept-flake-config develop --command bun2nix -l bun.lock -c ../ -o nix/bun.nix`.cwd(
		repoRoot,
	);
}

if (import.meta.main) await generateNixBunDeps();
