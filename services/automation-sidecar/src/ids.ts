/** Lowercase, `0x`-less, leading-zero-free, so short and padded ids compare equal. */
export function normalizeObjectId(id: string): string {
    return id.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
}
