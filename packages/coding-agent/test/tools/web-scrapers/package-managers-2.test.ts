import { describe, expect, it } from "bun:test";
import { handleDockerHub } from "@oh-my-pi/pi-coding-agent/web/scrapers/dockerhub";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleDockerHub", () => {
	it("returns null for non-DockerHub URLs", async () => {
		const result = await handleDockerHub("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for non-matching DockerHub paths", async () => {
		const result = await handleDockerHub("https://hub.docker.com/search", 20);
		expect(result).toBeNull();
	});

	it("fetches official nginx image", async () => {
		const result = await handleDockerHub("https://hub.docker.com/_/nginx", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("dockerhub");
		expect(result?.content).toContain("nginx");
		expect(result?.content).toContain("docker pull");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches grafana/grafana image", async () => {
		const result = await handleDockerHub("https://hub.docker.com/r/grafana/grafana", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("dockerhub");
		expect(result?.content).toContain("grafana");
		expect(result?.content).toContain("docker pull");
	});
});
