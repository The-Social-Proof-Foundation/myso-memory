/** An HTTP-facing bridge failure. Kept in its own module so delegate code can throw it. */
export class BridgeError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string,
    ) {
        super(message);
        this.name = "BridgeError";
    }
}
