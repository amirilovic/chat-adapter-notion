import { createHmac } from "node:crypto";
import { parseMarkdown } from "chat";
import { describe, expect, it } from "vite-plus/test";
import { NotionAdapter, createNotionAdapter } from "./notion-adapter.js";
import type { NotionRawMessage, NotionRichTextItem } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = "ntn_test_token";
const WEBHOOK_SECRET = "whsec_test_secret";

function makeAdapter(): NotionAdapter {
  return new NotionAdapter({ token: TOKEN, webhookSecret: WEBHOOK_SECRET });
}

function makeRichTextItem(content: string): NotionRichTextItem {
  return {
    type: "text",
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
    plain_text: content,
    href: null,
  };
}

function signPayload(body: string): string {
  const hmac = createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Thread ID encoding / decoding
// ---------------------------------------------------------------------------

describe("thread ID codec", () => {
  it("encodes and decodes a page-only thread ID (roundtrip)", () => {
    const adapter = makeAdapter();
    const data = { pageId: "abc-123-page" };
    const encoded = adapter.encodeThreadId(data);
    const decoded = adapter.decodeThreadId(encoded);
    expect(decoded.pageId).toBe("abc-123-page");
    expect(decoded.discussionId).toBeUndefined();
  });

  it("encodes and decodes a thread ID with discussionId (roundtrip)", () => {
    const adapter = makeAdapter();
    const data = { pageId: "page-456", discussionId: "disc-789" };
    const encoded = adapter.encodeThreadId(data);
    const decoded = adapter.decodeThreadId(encoded);
    expect(decoded.pageId).toBe("page-456");
    expect(decoded.discussionId).toBe("disc-789");
  });

  it("thread ID starts with notion: prefix", () => {
    const adapter = makeAdapter();
    const encoded = adapter.encodeThreadId({ pageId: "test" });
    expect(encoded.startsWith("notion:")).toBe(true);
  });

  it("throws on invalid thread ID format", () => {
    const adapter = makeAdapter();
    expect(() => adapter.decodeThreadId("invalid")).toThrow("Invalid Notion thread ID");
  });

  it("throws on wrong prefix", () => {
    const adapter = makeAdapter();
    expect(() => adapter.decodeThreadId("slack:abc")).toThrow("Invalid Notion thread ID");
  });
});

// ---------------------------------------------------------------------------
// channelIdFromThreadId
// ---------------------------------------------------------------------------

describe("channelIdFromThreadId", () => {
  it("returns prefix:encodedPageId (strips discussion part)", () => {
    const adapter = makeAdapter();
    const threadId = adapter.encodeThreadId({ pageId: "pg1", discussionId: "disc1" });
    const channelId = adapter.channelIdFromThreadId(threadId);
    // Should be first two colon-separated parts
    const parts = channelId.split(":");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("notion");
  });
});

// ---------------------------------------------------------------------------
// isDM
// ---------------------------------------------------------------------------

describe("isDM", () => {
  it("always returns false", () => {
    const adapter = makeAdapter();
    const threadId = adapter.encodeThreadId({ pageId: "any" });
    expect(adapter.isDM(threadId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseMessage
// ---------------------------------------------------------------------------

describe("parseMessage", () => {
  it("converts NotionRawMessage to Message", () => {
    const adapter = makeAdapter();
    const raw: NotionRawMessage = {
      id: "msg-1",
      discussionId: "disc-1",
      pageId: "page-1",
      richText: [makeRichTextItem("Hello from Notion")],
      createdBy: { id: "user-1" },
      createdTime: "2025-01-15T10:00:00.000Z",
    };

    const message = adapter.parseMessage(raw);
    expect(message.id).toBe("msg-1");
    expect(message.text).toContain("Hello from Notion");
    expect(message.author.userId).toBe("user-1");
    expect(message.raw).toBe(raw);
  });

  it("marks isMe=false when botUserId is not set", () => {
    const adapter = makeAdapter();
    const raw: NotionRawMessage = {
      id: "msg-2",
      discussionId: "disc-1",
      pageId: "page-1",
      richText: [makeRichTextItem("test")],
      createdBy: { id: "user-2" },
      createdTime: "2025-01-15T10:00:00.000Z",
    };

    const message = adapter.parseMessage(raw);
    expect(message.author.isMe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderFormatted
// ---------------------------------------------------------------------------

describe("renderFormatted", () => {
  it("stringifies an AST back to markdown", () => {
    const adapter = makeAdapter();
    const ast = parseMarkdown("**hello** world");
    const result = adapter.renderFormatted(ast);
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });
});

// ---------------------------------------------------------------------------
// handleWebhook — signature verification
// ---------------------------------------------------------------------------

describe("handleWebhook", () => {
  it("returns 401 for invalid signature", async () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "comment.created", data: { id: "c1" } });
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body,
      headers: { "x-notion-signature": "sha256=invalid" },
    });

    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(401);
  });

  it("returns 401 when signature header is missing", async () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "comment.created", data: { id: "c1" } });
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body,
    });

    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(401);
  });

  it("echoes back verification payload", async () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "verification", data: { verification_token: "tok" } });
    const signature = signPayload(body);
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body,
      headers: { "x-notion-signature": signature },
    });

    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.type).toBe("verification");
  });

  it("returns 200 for non-comment events", async () => {
    const adapter = makeAdapter();
    const body = JSON.stringify({ type: "page.updated", data: { id: "p1" } });
    const signature = signPayload(body);
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body,
      headers: { "x-notion-signature": signature },
    });

    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// No-op methods
// ---------------------------------------------------------------------------

describe("no-op methods", () => {
  it("deleteMessage resolves without error", async () => {
    const adapter = makeAdapter();
    await expect(adapter.deleteMessage("t", "m")).resolves.toBeUndefined();
  });

  it("addReaction resolves without error", async () => {
    const adapter = makeAdapter();
    await expect(adapter.addReaction("t", "m", "thumbsup")).resolves.toBeUndefined();
  });

  it("removeReaction resolves without error", async () => {
    const adapter = makeAdapter();
    await expect(adapter.removeReaction("t", "m", "thumbsup")).resolves.toBeUndefined();
  });

  it("startTyping resolves without error", async () => {
    const adapter = makeAdapter();
    await expect(adapter.startTyping("t")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe("createNotionAdapter", () => {
  it("creates adapter with explicit config", () => {
    const adapter = createNotionAdapter({
      token: "ntn_explicit",
      webhookSecret: "whsec_explicit",
    });
    expect(adapter).toBeInstanceOf(NotionAdapter);
    expect(adapter.name).toBe("notion");
  });

  it("falls back to env vars", () => {
    const originalToken = process.env.NOTION_TOKEN;
    const originalSecret = process.env.NOTION_WEBHOOK_SECRET;
    try {
      process.env.NOTION_TOKEN = "ntn_from_env";
      process.env.NOTION_WEBHOOK_SECRET = "whsec_from_env";
      const adapter = createNotionAdapter();
      expect(adapter).toBeInstanceOf(NotionAdapter);
    } finally {
      process.env.NOTION_TOKEN = originalToken;
      process.env.NOTION_WEBHOOK_SECRET = originalSecret;
    }
  });

  it("throws when token is missing", () => {
    const originalToken = process.env.NOTION_TOKEN;
    try {
      process.env.NOTION_TOKEN = "";
      expect(() => createNotionAdapter({ webhookSecret: "sec" })).toThrow("token");
    } finally {
      if (originalToken !== undefined) {
        process.env.NOTION_TOKEN = originalToken;
      }
    }
  });

  it("throws when webhook secret is missing", () => {
    const originalSecret = process.env.NOTION_WEBHOOK_SECRET;
    try {
      process.env.NOTION_WEBHOOK_SECRET = "";
      expect(() => createNotionAdapter({ token: "tok" })).toThrow("webhook secret");
    } finally {
      if (originalSecret !== undefined) {
        process.env.NOTION_WEBHOOK_SECRET = originalSecret;
      }
    }
  });
});
