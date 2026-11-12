/**
 * Web Fetch Special Handlers Index
 *
 * Builds the specialHandler list for site-specific content extraction.
 */
import { handleArxiv } from "./arxiv";
import { handleCratesIo } from "./crates-io";
import { handleCrossref } from "./crossref";
import { handleDockerHub } from "./dockerhub";
import { handleDocsRs } from "./docs-rs";
import { handleGitHub } from "./github";
import { handleGitLab } from "./gitlab";
import { handleHuggingFace } from "./huggingface";
import { handleMDN } from "./mdn";
import { handleNpm } from "./npm";
import { handlePubMed } from "./pubmed";
import { handlePyPI } from "./pypi";
import { handleReddit } from "./reddit";
import { handleStackOverflow } from "./stackoverflow";
import type { SpecialHandler } from "./types";
import { handleWikipedia } from "./wikipedia";
import { handleYouTube } from "./youtube";

export const specialHandlers: SpecialHandler[] = [
	// Git hosting
	handleGitHub,
	handleGitLab,
	// Video/Media
	handleYouTube,
	// Social/News
	handleReddit,
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
	// Academic
	handleArxiv,
	handleCrossref,
	handlePubMed,
	// Reference
	handleWikipedia,
];
