/**
 * Web Fetch Special Handlers Index
 *
 * Builds the specialHandler list for site-specific content extraction.
 */
import { handleCratesIo } from "./crates-io";
import { handleDockerHub } from "./dockerhub";
import { handleDocsRs } from "./docs-rs";
import { handleGitHub } from "./github";
import { handleGitLab } from "./gitlab";
import { handleHuggingFace } from "./huggingface";
import { handleMDN } from "./mdn";
import { handleNpm } from "./npm";
import { handlePyPI } from "./pypi";
import { handleStackOverflow } from "./stackoverflow";
import type { SpecialHandler } from "./types";

export const specialHandlers: SpecialHandler[] = [
	// Git hosting
	handleGitHub,
	handleGitLab,
	// Developer content
	handleStackOverflow,
	handleMDN,
	handleDocsRs,
	// Package registries
	handleNpm,
	handlePyPI,
	handleCratesIo,
	handleDockerHub,
	// ML/AI
	handleHuggingFace,
];
