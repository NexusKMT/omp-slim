/**
 * Type declarations for Bun's import attributes.
 * These allow importing non-JS files as text at build time.
 */

declare module "*.md" {
	const content: string;
	export default content;
}

declare module "*.txt" {
	const content: string;
	export default content;
}
