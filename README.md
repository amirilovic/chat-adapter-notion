# chat-adapter-notion

ChatSDK adapter for [Notion](https://notion.so). Uses Notion page comments as a chat channel — each page is a thread, each comment is a message, and discussion threads map to sub-threads.

## Install

```bash
npm install chat-adapter-notion
# or
pnpm add chat-adapter-notion
```

## Quick start

```typescript
import { createChat } from "chat";
import { createNotionAdapter } from "chat-adapter-notion";

const adapter = createNotionAdapter({
  token: "ntn_...", // Notion integration token
  webhookSecret: "whsec_...", // Webhook signing secret
});

const chat = createChat({ adapters: [adapter] });
await chat.start();
```

### Environment variables

Instead of passing config directly, you can set environment variables:

| Variable                | Description                              |
| ----------------------- | ---------------------------------------- |
| `NOTION_TOKEN`          | Notion internal integration token        |
| `NOTION_WEBHOOK_SECRET` | Secret used to verify webhook signatures |

```typescript
// Reads from NOTION_TOKEN and NOTION_WEBHOOK_SECRET
const adapter = createNotionAdapter();
```

## Webhook setup

### 1. Create a Notion integration

Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and create a new internal integration. Copy the **integration token** — this is your `token` / `NOTION_TOKEN`.

### 2. Deploy your webhook endpoint

Your server needs a publicly accessible HTTPS URL. Route POST requests to the adapter:

```typescript
app.post("/webhooks/notion", async (req) => {
  return adapter.handleWebhook(req);
});
```

### 3. Create a webhook subscription

In your integration settings, go to the **Webhooks** tab:

1. Click **+ Create a subscription**
2. Enter your public endpoint URL (e.g. `https://your-app.com/webhooks/notion`)
3. Select **comment.created** as the event type

### 4. Complete the verification handshake

When you save, Notion sends a POST with a `verification_token` to your endpoint. The adapter responds to this automatically — it echoes the payload back with a 200.

Back in the Notion UI, click **Verify**, paste the token from the request body, and confirm.

After verification, Notion uses the verification token as the HMAC-SHA256 signing key for all future webhook events. Use it as your `webhookSecret` / `NOTION_WEBHOOK_SECRET`.

### 5. Grant page access

The integration needs access to each page you want to monitor. In a Notion page, click **...** → **Connections** → add your integration. Without this, the bot won't receive comment events or be able to read/post comments.

### How the webhook handler works

Once configured, the adapter's `handleWebhook` method:

1. Verifies the `X-Notion-Signature` HMAC-SHA256 signature
2. Responds to Notion's verification handshake automatically
3. Fetches the full comment via the API (webhook payloads are sparse)
4. Converts Notion rich text to markdown and processes the message

## Thread IDs

Thread IDs encode the Notion page and optional discussion thread:

```
notion:{base64url(pageId)}
notion:{base64url(pageId)}:{base64url(discussionId)}
```

Use `encodeThreadId` / `decodeThreadId` to work with them:

```typescript
const threadId = adapter.encodeThreadId({ pageId: "abc-123" });
const { pageId, discussionId } = adapter.decodeThreadId(threadId);
```

## Sending messages

Post messages as markdown, an AST, or raw text:

```typescript
await adapter.postMessage(threadId, "Hello **world**");
await adapter.postMessage(threadId, { markdown: "# Title\nBody text" });
await adapter.postMessage(threadId, { ast: someAstRoot });
```

Markdown is automatically converted to Notion rich text with support for bold, italic, strikethrough, inline code, code blocks, and links. Text longer than 2000 characters is automatically chunked to stay within Notion's API limits.

## Format conversion utilities

The package also exports lower-level conversion functions:

```typescript
import {
  markdownToRichText,
  richTextToMarkdown,
  richTextToAst,
  astToRichText,
} from "chat-adapter-notion";

// Markdown string → Notion rich text request items
const richText = markdownToRichText("**bold** and *italic*");

// Notion rich text response items → Markdown string
const markdown = richTextToMarkdown(notionRichTextItems);

// Notion rich text → mdast tree (and back)
const ast = richTextToAst(notionRichTextItems);
const items = astToRichText(ast);
```

## Limitations

The Notion API does not support editing or deleting comments, reactions, or typing indicators. These methods are implemented as graceful no-ops:

- `editMessage` — posts a new comment instead of editing
- `deleteMessage` — no-op
- `addReaction` / `removeReaction` — no-op
- `startTyping` — no-op

## Development

```bash
pnpm install
pnpm test       # run tests
pnpm lint       # lint + format + typecheck
pnpm lint:fix   # auto-fix lint/format issues
pnpm build      # build to dist/
```
