/**
 * Negative-path probe for the user-facing OTLP export opt-out. Runs in a
 * subprocess because successful exporter registration is process-global.
 */
import { Settings } from "../src/config/settings";
import {
	cfgTelemetryOtlpExportEnabled,
	flushTelemetryExport,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { trace } from "@opentelemetry/api";

let received = false;
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		if (req.method === "POST") {
			await req.arrayBuffer();
			received = true;
			return new Response('{"partialSuccess":{}}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	},
});

process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://localhost:${server.port}/v1/traces`;
process.env.OTEL_TRACES_EXPORTER = "otlp";

const settings = Settings.isolated({ "telemetry.otlpExportEnabled": false });
await initTelemetryExport(cfgTelemetryOtlpExportEnabled.get(settings));
const span = trace.getTracer("@oh-my-pi/pi-agent-core").startSpan("disabled-export-probe");
span.end();
await flushTelemetryExport();
await server.stop(true);

const disabled = !isTelemetryExportEnabled() && !received;
console.log(disabled ? "PROBE: DISABLED" : `PROBE: UNEXPECTED_EXPORT received=${received}`);
process.exit(disabled ? 0 : 1);
