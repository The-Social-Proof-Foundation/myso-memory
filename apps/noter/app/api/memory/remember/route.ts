/** Legacy server-side user signing is disabled. */
export async function POST() {
  return Response.json({code: "client_signing_required", error: "Use client-signed Memory requests from the chat app."}, {status: 409});
}
