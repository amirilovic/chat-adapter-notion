import { Client, isFullComment, isFullPage } from "@notionhq/client";
import {
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  ConsoleLogger,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type Logger,
  Message,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import { stringifyMarkdown } from "chat";
import {
  astToRichText,
  markdownToRichText,
  richTextToAst,
  richTextToMarkdown,
} from "./format-converter.js";
import type {
  NotionAdapterConfig,
  NotionRawMessage,
  NotionRichTextItem,
  NotionRichTextRequest,
  NotionThreadId,
  NotionWebhookPayload,
} from "./types.js";
import { verifyWebhookSignature } from "./webhook.js";

// ---------------------------------------------------------------------------
// Thread-ID codec helpers
// ---------------------------------------------------------------------------

const THREAD_PREFIX = "notion";

function base64urlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function base64urlDecode(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString();
}

// ---------------------------------------------------------------------------
// Postable → rich-text helper
// ---------------------------------------------------------------------------

function postableToRichText(message: AdapterPostableMessage): NotionRichTextRequest[] {
  if (typeof message === "string") {
    return markdownToRichText(message);
  }
  if ("markdown" in message && typeof message.markdown === "string") {
    return markdownToRichText(message.markdown);
  }
  if ("ast" in message) {
    return astToRichText(message.ast);
  }
  if ("raw" in message && typeof message.raw === "string") {
    return markdownToRichText(message.raw);
  }
  if ("card" in message) {
    const fallback = message.fallbackText ?? "Card content";
    return markdownToRichText(fallback);
  }
  // Fallback
  return markdownToRichText(JSON.stringify(message));
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class NotionAdapter implements Adapter<NotionThreadId, NotionRawMessage> {
  readonly name = "notion";
  readonly userName: string;

  readonly botUserId: string | undefined;

  private chat!: ChatInstance;
  private client: Client;
  private config: NotionAdapterConfig;
  private logger: Logger;

  constructor(config: NotionAdapterConfig) {
    this.config = config;
    this.logger = config.logger ?? new ConsoleLogger("info", "notion");
    this.userName = "Notion Bot";
    this.client = new Client({ auth: config.token });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger("notion");

    // Validate token by fetching bot user
    try {
      const me = await this.client.users.me({});
      (this as { botUserId: string | undefined }).botUserId = me.id;
      this.logger.info(`Authenticated as bot: ${me.name ?? me.id}`);
    } catch (err) {
      this.logger.error("Failed to validate Notion token via users.me()", err);
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Thread-ID codec
  // -----------------------------------------------------------------------

  encodeThreadId(data: NotionThreadId): string {
    const parts = [THREAD_PREFIX, base64urlEncode(data.pageId)];
    if (data.discussionId) {
      parts.push(base64urlEncode(data.discussionId));
    }
    return parts.join(":");
  }

  decodeThreadId(threadId: string): NotionThreadId {
    const parts = threadId.split(":");
    if (parts.length < 2 || parts[0] !== THREAD_PREFIX) {
      throw new Error(`Invalid Notion thread ID: ${threadId}`);
    }
    return {
      pageId: base64urlDecode(parts[1]),
      discussionId: parts[2] ? base64urlDecode(parts[2]) : undefined,
    };
  }

  channelIdFromThreadId(threadId: string): string {
    // Channel = page, so return prefix + encoded pageId
    const parts = threadId.split(":");
    return `${parts[0]}:${parts[1]}`;
  }

  isDM(_threadId: string): boolean {
    return false; // Notion pages are never DMs
  }

  // -----------------------------------------------------------------------
  // Webhook
  // -----------------------------------------------------------------------

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const body = await request.text();

    // 1. Verify HMAC signature
    const signature = request.headers.get("x-notion-signature");
    if (!verifyWebhookSignature(body, signature, this.config.webhookSecret)) {
      this.logger.warn("Webhook signature verification failed");
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: NotionWebhookPayload;
    try {
      payload = JSON.parse(body) as NotionWebhookPayload;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // 2. Handle verification handshake (Notion sends a verification_token event)
    if (payload.type === "verification") {
      return Response.json(payload);
    }

    // 3. Only handle comment.created events
    if (payload.type !== "comment.created") {
      return new Response("OK", { status: 200 });
    }

    const commentId = payload.data?.id;
    if (!commentId) {
      return new Response("Missing comment ID", { status: 400 });
    }

    // 4. Fetch full comment via API (webhook payload is sparse)
    const fetchAndProcess = async () => {
      try {
        const comment = await this.client.comments.list({
          block_id: this.extractPageId(payload),
        });

        const fullComment = comment.results.find((c) => c.id === commentId);
        if (!fullComment || !isFullComment(fullComment)) {
          this.logger.warn(`Could not find full comment ${commentId}`);
          return;
        }

        // 5. Skip comments from our own bot
        if (fullComment.created_by.id === this.botUserId) {
          this.logger.debug("Skipping own bot comment");
          return;
        }

        // 6. Build thread ID
        const pageId = this.extractPageId(payload);
        const threadId = this.encodeThreadId({
          pageId,
          discussionId: fullComment.discussion_id,
        });

        // 7. Convert to ChatMessage and process
        const rawMessage = this.commentToRawMessage(fullComment, pageId);
        const message = this.parseMessage(rawMessage);

        this.chat.processMessage(this, threadId, message, options);
      } catch (err) {
        this.logger.error("Error processing webhook comment", err);
      }
    };

    if (options?.waitUntil) {
      options.waitUntil(fetchAndProcess());
    } else {
      await fetchAndProcess();
    }

    return new Response("OK", { status: 200 });
  }

  private extractPageId(payload: NotionWebhookPayload): string {
    const parent = payload.data?.parent;
    if (parent?.page_id) return parent.page_id;
    if (parent?.block_id) return parent.block_id;
    // Fallback: try data-level fields
    const dataAny = payload.data as Record<string, unknown>;
    if (typeof dataAny.page_id === "string") return dataAny.page_id;
    throw new Error("Cannot determine page ID from webhook payload");
  }

  // -----------------------------------------------------------------------
  // Messaging
  // -----------------------------------------------------------------------

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<NotionRawMessage>> {
    const { pageId, discussionId } = this.decodeThreadId(threadId);
    const richText = postableToRichText(message);

    // biome-ignore lint/suspicious/noExplicitAny: Notion client types are complex unions
    let params: any;
    if (discussionId) {
      params = { discussion_id: discussionId, rich_text: richText };
    } else {
      params = { parent: { page_id: pageId }, rich_text: richText };
    }

    const created = await this.client.comments.create(params);

    const raw: NotionRawMessage = {
      id: created.id,
      discussionId: isFullComment(created) ? created.discussion_id : "",
      pageId,
      richText: isFullComment(created)
        ? (created.rich_text as unknown as NotionRichTextItem[])
        : [],
      createdBy: isFullComment(created) ? { id: created.created_by.id } : { id: "" },
      createdTime: isFullComment(created) ? created.created_time : new Date().toISOString(),
    };

    return { id: created.id, raw, threadId };
  }

  async editMessage(
    threadId: string,
    _messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<NotionRawMessage>> {
    // Notion API does not support editing comments — fall back to posting a new one
    this.logger.debug("editMessage: Notion cannot edit comments, posting new message");
    return this.postMessage(threadId, message);
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    // Notion API does not support deleting comments — no-op
    this.logger.debug("deleteMessage: Notion cannot delete comments, no-op");
  }

  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    // Not supported by Notion — no-op
  }

  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    // Not supported by Notion — no-op
  }

  async startTyping(_threadId: string): Promise<void> {
    // Not supported by Notion — no-op
  }

  // -----------------------------------------------------------------------
  // Fetching
  // -----------------------------------------------------------------------

  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<NotionRawMessage>> {
    const { pageId, discussionId } = this.decodeThreadId(threadId);

    const response = await this.client.comments.list({
      block_id: pageId,
      start_cursor: options?.cursor ?? undefined,
      page_size: options?.limit ?? 100,
    });

    let comments = response.results.filter(isFullComment);

    // Filter by discussion if sub-thread
    if (discussionId) {
      comments = comments.filter((c) => c.discussion_id === discussionId);
    }

    const messages = comments.map((c) => {
      const raw = this.commentToRawMessage(c, pageId);
      return this.parseMessage(raw);
    });

    return {
      messages,
      nextCursor: response.has_more && response.next_cursor ? response.next_cursor : undefined,
    };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { pageId } = this.decodeThreadId(threadId);

    const page = await this.client.pages.retrieve({ page_id: pageId });

    let title = "Untitled";
    if (isFullPage(page)) {
      // Try to extract title from properties
      for (const prop of Object.values(page.properties)) {
        if (prop.type === "title" && "title" in prop) {
          const titleParts = prop.title as Array<{ plain_text: string }>;
          if (titleParts.length > 0) {
            title = titleParts.map((t) => t.plain_text).join("");
          }
          break;
        }
      }
    }

    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      channelName: title,
      metadata: { pageId, title },
    };
  }

  // -----------------------------------------------------------------------
  // Message conversion
  // -----------------------------------------------------------------------

  parseMessage(raw: NotionRawMessage): Message<NotionRawMessage> {
    const markdown = richTextToMarkdown(raw.richText);
    const formatted = richTextToAst(raw.richText);
    return new Message<NotionRawMessage>({
      id: raw.id,
      threadId: "",
      text: markdown.trim(),
      formatted,
      raw,
      author: {
        userId: raw.createdBy.id,
        userName: raw.createdBy.id,
        fullName: raw.createdBy.id,
        isBot: "unknown" as const,
        isMe: raw.createdBy.id === this.botUserId,
      },
      metadata: {
        dateSent: new Date(raw.createdTime),
        edited: false,
      },
      attachments: [],
    });
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private commentToRawMessage(
    comment: {
      id: string;
      discussion_id: string;
      rich_text: unknown[];
      created_by: { id: string };
      created_time: string;
    },
    pageId: string,
  ): NotionRawMessage {
    return {
      id: comment.id,
      discussionId: comment.discussion_id,
      pageId,
      richText: comment.rich_text as unknown as NotionRichTextItem[],
      createdBy: { id: comment.created_by.id },
      createdTime: comment.created_time,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a NotionAdapter with optional config overrides.
 * Falls back to environment variables `NOTION_TOKEN` and `NOTION_WEBHOOK_SECRET`.
 */
export function createNotionAdapter(config?: Partial<NotionAdapterConfig>): NotionAdapter {
  const token = config?.token ?? process.env.NOTION_TOKEN;
  const webhookSecret = config?.webhookSecret ?? process.env.NOTION_WEBHOOK_SECRET;

  if (!token) {
    throw new Error("Notion token is required (config.token or NOTION_TOKEN env var)");
  }
  if (!webhookSecret) {
    throw new Error(
      "Notion webhook secret is required (config.webhookSecret or NOTION_WEBHOOK_SECRET env var)",
    );
  }

  return new NotionAdapter({
    token,
    webhookSecret,
    logger: config?.logger,
  });
}
