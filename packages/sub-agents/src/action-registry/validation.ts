import type {
    JsonPropertySchema,
    SocialActionInputSchema,
    SocialActionValidationIssue,
    SocialActionValidationResult,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validateProperty(
    path: string,
    value: unknown,
    schema: JsonPropertySchema,
): SocialActionValidationIssue[] {
    if (schema.type === "string") {
        if (typeof value !== "string") {
            return [{ code: "invalid_type", path, message: `${path} must be a string` }];
        }
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            return [
                {
                    code: "min_length",
                    path,
                    message: `${path} must contain at least ${schema.minLength} character(s)`,
                },
            ];
        }
        return [];
    }

    if (schema.type === "boolean") {
        return typeof value === "boolean"
            ? []
            : [{ code: "invalid_type", path, message: `${path} must be a boolean` }];
    }

    if (schema.type === "integer") {
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
            return [
                {
                    code: "invalid_type",
                    path,
                    message: `${path} must be a safe integer`,
                },
            ];
        }
        if (
            (schema.minimum !== undefined && value < schema.minimum) ||
            (schema.maximum !== undefined && value > schema.maximum) ||
            (schema.enum !== undefined && !schema.enum.includes(value))
        ) {
            return [
                {
                    code: "invalid_value",
                    path,
                    message: `${path} is outside the accepted integer values`,
                },
            ];
        }
        return [];
    }

    if (!Array.isArray(value)) {
        return [{ code: "invalid_type", path, message: `${path} must be an array` }];
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return [
            {
                code: "max_items",
                path,
                message: `${path} must contain no more than ${schema.maxItems} item(s)`,
            },
        ];
    }

    return value.flatMap((item, index) =>
        validateProperty(`${path}[${index}]`, item, schema.items),
    );
}

export function createSocialActionValidator<T>(
    schema: SocialActionInputSchema,
): (input: unknown) => SocialActionValidationResult<T> {
    return (input) => {
        if (!isPlainObject(input)) {
            return {
                success: false,
                issues: [
                    {
                        code: "invalid_object",
                        path: "$",
                        message: "Action parameters must be a plain JSON object",
                    },
                ],
            };
        }

        const issues: SocialActionValidationIssue[] = [];
        const allowedKeys = new Set(Object.keys(schema.properties));

        for (const requiredKey of schema.required) {
            if (!Object.hasOwn(input, requiredKey)) {
                issues.push({
                    code: "required",
                    path: `$.${requiredKey}`,
                    message: `${requiredKey} is required`,
                });
            }
        }

        for (const [key, value] of Object.entries(input)) {
            const propertySchema = schema.properties[key];
            if (!allowedKeys.has(key) || propertySchema === undefined) {
                issues.push({
                    code: "additional_property",
                    path: `$.${key}`,
                    message: `${key} is not accepted for this action`,
                });
                continue;
            }
            issues.push(...validateProperty(`$.${key}`, value, propertySchema));
        }

        return issues.length > 0
            ? { success: false, issues }
            : { success: true, value: input as T };
    };
}
