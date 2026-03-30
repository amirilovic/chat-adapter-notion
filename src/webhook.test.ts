import { createHmac } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { verifyWebhookSignature } from "./webhook.js";

const SECRET = "test-webhook-secret";

function sign(body: string, secret = SECRET): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  const body = '{"type":"comment.created","data":{"id":"abc"}}';

  it("returns true for a valid signature", () => {
    const signature = sign(body);
    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const signature = sign(body);
    // Tamper with the body
    expect(verifyWebhookSignature(`${body}x`, signature, SECRET)).toBe(false);
  });

  it("returns false for null signature", () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
  });

  it("returns false for undefined signature", () => {
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
  });

  it("returns false for empty string signature", () => {
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
  });

  it("returns false for signature without sha256= prefix", () => {
    const hmac = createHmac("sha256", SECRET);
    hmac.update(body);
    const hexOnly = hmac.digest("hex");
    expect(verifyWebhookSignature(body, hexOnly, SECRET)).toBe(false);
  });

  it("returns false for different length signatures", () => {
    expect(verifyWebhookSignature(body, "sha256=abcd", SECRET)).toBe(false);
  });

  it("returns false when signed with wrong secret", () => {
    const wrongSignature = sign(body, "wrong-secret");
    expect(verifyWebhookSignature(body, wrongSignature, SECRET)).toBe(false);
  });

  it("works with Buffer body", () => {
    const bufferBody = Buffer.from(body);
    const signature = sign(body);
    expect(verifyWebhookSignature(bufferBody, signature, SECRET)).toBe(true);
  });
});
