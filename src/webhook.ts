import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Notion webhook HMAC-SHA256 signature.
 *
 * Notion signs payloads with HMAC-SHA256 and sends the signature in the
 * `X-Notion-Signature` header as `sha256=<hex_digest>`.
 *
 * @returns `true` when the signature is valid, `false` otherwise.
 */
export function verifyWebhookSignature(
  body: string | Buffer,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature) return false;

  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;

  const expectedHex = signature.slice(prefix.length);

  const hmac = createHmac("sha256", secret);
  hmac.update(typeof body === "string" ? body : body);
  const computedHex = hmac.digest("hex");

  // Guard against length-oracle timing attacks
  if (expectedHex.length !== computedHex.length) return false;

  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(computedHex, "hex"));
}
