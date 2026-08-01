import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkills, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";

function makeSkillMd(name: string, dir: string) {
	return `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n# ${name} from ${dir}\n`;
}

describe("skill:// resolution honors skills.customDirectories (#7190)", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	it("resolves a skill loaded from a custom directory", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-skills-"));
		tempDirs.push(tempDir);
		const skillDir = path.join(tempDir, "my-custom-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), makeSkillMd("my-custom-skill", tempDir));

		const { skills } = await loadSkills({
			enableCodexUser: false,
			enableClaudeUser: false,
			enableClaudeProject: false,
			enablePiUser: false,
			enablePiProject: false,
			enableAgentsUser: false,
			enableAgentsProject: false,
			customDirectories: [tempDir],
		});
		setActiveSkills(skills);

		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve({
			scheme: "skill",
			href: "skill://my-custom-skill",
			rawHost: "my-custom-skill",
			hostname: "my-custom-skill",
			pathname: "/",
		} as any);
		expect(resource.sourcePath).toBe(path.join(skillDir, "SKILL.md"));
		expect(resource.content).toContain(`from ${tempDir}`);
	});

	it("keeps first-wins across multiple custom directories", async () => {
		const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-a-"));
		tempDirs.push(dirA);
		const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-b-"));
		tempDirs.push(dirB);
		const skillA = path.join(dirA, "same-name");
		const skillB = path.join(dirB, "same-name");
		await fs.mkdir(skillA, { recursive: true });
		await fs.mkdir(skillB, { recursive: true });
		await fs.writeFile(path.join(skillA, "SKILL.md"), makeSkillMd("same-name", dirA));
		await fs.writeFile(path.join(skillB, "SKILL.md"), makeSkillMd("same-name", dirB));

		const { skills, warnings } = await loadSkills({
			enableCodexUser: false,
			enableClaudeUser: false,
			enableClaudeProject: false,
			enablePiUser: false,
			enablePiProject: false,
			enableAgentsUser: false,
			enableAgentsProject: false,
			customDirectories: [dirA, dirB],
		});
		setActiveSkills(skills);

		const dup = skills.find(s => s.name === "same-name");
		expect(dup).toBeDefined();
		// Same-source (custom) duplicates keep first-wins: dirA claims the name.
		expect(dup!.filePath).toBe(path.join(skillA, "SKILL.md"));
		expect(warnings.some(w => w.message.includes("collision"))).toBe(true);

		const handler = new SkillProtocolHandler();
		const resource = await handler.resolve({
			scheme: "skill",
			href: "skill://same-name",
			rawHost: "same-name",
			hostname: "same-name",
			pathname: "/",
		} as any);
		expect(resource.sourcePath).toBe(path.join(skillA, "SKILL.md"));
	});
});
