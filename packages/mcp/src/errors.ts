export type McpErrorCode =
    | "INVALID_ARGUMENT"
    | "INVALID_CONFIGURATION"
    | "UNSAFE_LEGACY_CREDENTIALS"
    | "SIGNER_UNAVAILABLE"
    | "SOCIAL_GATEWAY_UNAVAILABLE"
    | "APPROVAL_FLOW_NOT_AVAILABLE"
    | "AUTHENTICATION_FAILED"
    | "CAPABILITY_DENIED"
    | "RATE_LIMITED"
    | "CONFLICT"
    | "UPSTREAM_UNAVAILABLE"
    | "UNKNOWN_TOOL"
    | "INTERNAL_ERROR";

export interface StructuredMcpError {
    code: McpErrorCode;
    message: string;
    retryable: boolean;
    approvalRequired: boolean;
    actionId?: string;
    digest?: string;
}

export class McpRuntimeError extends Error {
    readonly code: McpErrorCode;
    readonly retryable: boolean;
    readonly approvalRequired: boolean;
    readonly actionId?: string;
    readonly digest?: string;

    constructor(
        code: McpErrorCode,
        message: string,
        options: {
            retryable?: boolean;
            approvalRequired?: boolean;
            actionId?: string;
            digest?: string;
            cause?: unknown;
        } = {},
    ) {
        super(message, { cause: options.cause });
        this.name = "McpRuntimeError";
        this.code = code;
        this.retryable = options.retryable ?? false;
        this.approvalRequired = options.approvalRequired ?? false;
        this.actionId = options.actionId;
        this.digest = options.digest;
    }
}

const SECRET_ASSIGNMENT = /\b(key|secret|token|authorization)\b\s*[:=]\s*[^\s,;}]+/gi;
const MYSO_PRIVATE_KEY = /mysoprivkey1[a-z0-9]+/gi;

export function redactSensitiveText(value: string): string {
    return value
        .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
        .replace(MYSO_PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]")
        .slice(0, 400);
}

export function toStructuredMcpError(error: unknown): StructuredMcpError {
    if (error instanceof McpRuntimeError) {
        return {
            code: error.code,
            message: redactSensitiveText(error.message),
            retryable: error.retryable,
            approvalRequired: error.approvalRequired,
            ...(error.actionId ? { actionId: error.actionId } : {}),
            ...(error.digest ? { digest: error.digest } : {}),
        };
    }

    if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) {
        return {
            code: "UPSTREAM_UNAVAILABLE",
            message: "The configured upstream service is unavailable.",
            retryable: true,
            approvalRequired: false,
        };
    }

    return {
        code: "INTERNAL_ERROR",
        message: "The MCP server could not complete the request.",
        retryable: false,
        approvalRequired: false,
    };
}

export function formatStartupError(error: unknown): string {
    return toStructuredMcpError(
        error instanceof McpRuntimeError
            ? error
            : new McpRuntimeError("INVALID_CONFIGURATION", "The MCP server could not start.", {
                  cause: error,
              }),
    ).message;
}
