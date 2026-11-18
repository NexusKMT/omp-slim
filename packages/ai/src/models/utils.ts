export { isRecord } from "@oh-my-pi/pi-utils";

export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

export function toPositiveNumber(value: unknown, fallback: number): number;
export function toPositiveNumber(value: unknown, fallback: number | null): number | null;
export function toPositiveNumber(value: unknown, fallback: number | null): number | null {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : fallback;
}

/** Positive finite number, or `null` when the value is missing/non-positive. */
export function toPositiveNumberOrNull(value: unknown): number | null {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : null;
}

export function toBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}
