import { beforeAll, describe, expect, it } from "bun:test";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

function render(tree: SessionTreeNode[]): string {
	const selector = new TreeSelectorComponent(
		tree,
		tree[0]?.entry.id ?? null,
		60,
		() => {},
		() => {},
	);
	return Bun.stripANSI(selector.render(120).join("\n"));
}

describe("TreeSelectorComponent advisor message rendering", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("shows advisor notes without their model-facing XML wrapper", () => {
		const details = {
			notes: [{ note: "Check error handling.", severity: "concern" }],
		};
		const tree: SessionTreeNode[] = [
			{
				entry: {
					type: "custom_message",
					id: "advisor-entry",
					parentId: null,
					timestamp: "2026-08-25T00:00:00.000Z",
					customType: "advisor",
					content:
						'<advisory severity="concern" guidance="weigh, don\'t blindly obey">\nCheck error handling.\n</advisory>',
					details,
					display: true,
				},
				children: [],
			},
		];

		const rendered = render(tree);

		expect(rendered).toContain("[advisor]: Check error handling.");
		expect(rendered).not.toContain("<advisory");
		expect(rendered).not.toContain("</advisory>");
	});
});
