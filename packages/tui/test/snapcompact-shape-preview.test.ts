import { beforeAll, describe, expect, it } from "bun:test";
import { getNativeBlob } from "@oh-my-pi/pi-tui/native/blobs";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { SnapcompactShapePreview } from "@oh-my-pi/pi-tui/overlays/snapcompact-shape-preview";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(theme);
});

/** A preview whose async sample renders can be awaited. */
interface PreviewHarness {
	component: SnapcompactShapePreview;
	/** Resolves at the component's next `requestRender`, i.e. when a sample render settles. */
	rendered: () => Promise<void>;
}

function preview(): PreviewHarness {
	let settled = Promise.withResolvers<void>();
	const component = new SnapcompactShapePreview("auto", { requestRender: () => settled.resolve() });
	return {
		component,
		rendered: () => {
			settled = Promise.withResolvers<void>();
			return settled.promise;
		},
	};
}

/** Select `value` and describe until its sample settles: the caption line and the sample's PNG bytes. */
async function show(
	{ component, rendered }: PreviewHarness,
	value: string,
): Promise<{ caption: string; png: Uint8Array }> {
	component.setValue(value);
	for (;;) {
		const [caption, sample] = component.describe(CX).c as NativeNode[];
		if (sample.k === "spinner") {
			await rendered();
			continue;
		}
		if (caption.k !== "text" || sample.k !== "image")
			throw new Error(`no ${value} sample: ${JSON.stringify(sample)}`);
		const png = sample.p?.blob ? getNativeBlob(sample.p.blob)?.bytes : undefined;
		if (!png) throw new Error(`no ${value} sample bytes`);
		return { caption: (caption.p?.spans ?? []).map(span => span.t).join(""), png };
	}
}

describe("snapcompact shape preview", () => {
	it("names each explicit variant and its actual frame geometry", async () => {
		const samples = preview();
		const auto = await show(samples, "auto");
		// The generic default uses 8-pixel cells and a 22-pixel line pitch.
		expect(auto.caption).toContain("· auto → 8on22-bw · full frame 196×71 cells");
		expect(auto.caption).toContain("≈ 5.0k tokens");
		for (const variant of ["11on16-bw", "silver16-bw", "8on22-bw", "5x8-bw", "doc-8on16-bw"]) {
			expect((await show(samples, variant)).caption).toContain(`· ${variant} · full frame`);
		}
		expect((await show(samples, "silver16-bw")).caption).toContain("full frame 98×98 cells");
	});

	it("renders a separate sample for each variant", async () => {
		const samples = preview();
		const tracked = await show(samples, "8on22-bw");
		const silver = await show(samples, "silver16-bw");
		expect(Buffer.from(silver.png).equals(Buffer.from(tracked.png))).toBe(false);
		// The default shares the explicit 8on22-bw sample.
		expect(Buffer.from((await show(samples, "auto")).png).equals(Buffer.from(tracked.png))).toBe(true);
	});
});
