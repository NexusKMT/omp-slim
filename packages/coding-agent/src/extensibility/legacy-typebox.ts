import { fromJsonSchema } from "@oh-my-pi/omptype";
import { Type as OmpType, type TypeBuilder as OmpTypeBuilder, type TUnsafe } from "@oh-my-pi/omptype/typebox";
import { upgradeJsonSchemaTo202012, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";

export * from "@oh-my-pi/omptype/typebox";

const VALIDATION_FAILURE = Symbol("pi.typebox.validationFailure");

interface ValidationFailure {
	message: string;
	readonly [VALIDATION_FAILURE]: true;
}

interface SafeParseSuccess<T> {
	success: true;
	data: T;
}

interface SafeParseFailure {
	success: false;
	error: ValidationFailure;
}

type LegacyUnsafeSchema<T> = TUnsafe<T> & {
	__validator(data: unknown): T | ValidationFailure;
	safeParse(input: unknown): SafeParseSuccess<T> | SafeParseFailure;
};

function isValidationFailure<T>(result: T | ValidationFailure): result is ValidationFailure {
	return typeof result === "object" && result !== null && VALIDATION_FAILURE in result;
}

function defineHidden(target: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		writable: true,
		configurable: true,
	});
}

function unsafe<T = unknown>(jsonSchema: Record<string, unknown> = {}): LegacyUnsafeSchema<T> {
	const document = { ...jsonSchema };
	const upgradedSchema = upgradeJsonSchemaTo202012(document);
	const validate = (data: unknown): T | ValidationFailure => {
		const result = validateJsonSchemaValue(upgradedSchema, data);
		if (result.success) return data as T;
		let message = "";
		for (const issue of result.issues) {
			if (message) message += "; ";
			message += issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
		}
		const failure = { message: message || "Invalid value" } as ValidationFailure;
		defineHidden(failure, VALIDATION_FAILURE, true);
		return failure;
	};
	const schema = fromJsonSchema(upgradedSchema).narrow((data, ctx) => {
		const result = validate(data);
		return isValidationFailure(result) ? ctx.mustBe(result.message) : true;
	}) as unknown as LegacyUnsafeSchema<T>;
	defineHidden(schema, "toJsonSchema", () => document);
	defineHidden(schema, "__validator", validate);
	defineHidden(schema, "safeParse", (input: unknown): SafeParseSuccess<T> | SafeParseFailure => {
		const result = validate(input);
		return isValidationFailure(result) ? { success: false, error: result } : { success: true, data: result };
	});
	return schema;
}

export const Type = { ...OmpType, Unsafe: unsafe } as unknown as OmpTypeBuilder;
export type TypeBuilder = OmpTypeBuilder;

const legacyTypeBox: { Type: OmpTypeBuilder } = { Type };
export default legacyTypeBox;
