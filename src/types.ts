import type { Logger } from "chat";

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

export interface NotionAdapterConfig {
  /** Notion integration token (env: NOTION_TOKEN) */
  token: string;
  /** Webhook signing secret for HMAC-SHA256 verification (env: NOTION_WEBHOOK_SECRET) */
  webhookSecret: string;
  /** Optional logger instance */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Thread-ID codec
// ---------------------------------------------------------------------------

export interface NotionThreadId {
  pageId: string;
  discussionId?: string;
}

// ---------------------------------------------------------------------------
// Raw message (platform-specific payload kept on Message.raw)
// ---------------------------------------------------------------------------

export interface NotionRawMessage {
  id: string;
  discussionId: string;
  pageId: string;
  richText: NotionRichTextItem[];
  createdBy: { id: string };
  createdTime: string;
}

// ---------------------------------------------------------------------------
// Notion API types — defined locally to avoid importing from
// @notionhq/client/build/src/api-endpoints which doesn't resolve
// under Node16 module resolution.
// ---------------------------------------------------------------------------

/** Annotations present on a rich-text *response* object */
export interface NotionAnnotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
}

/** A single rich-text item as returned by the Notion API */
export type NotionRichTextItem =
  | NotionTextRichTextItem
  | NotionMentionRichTextItem
  | NotionEquationRichTextItem;

export interface NotionTextRichTextItem {
  type: "text";
  text: { content: string; link: { url: string } | null };
  annotations: NotionAnnotations;
  plain_text: string;
  href: string | null;
}

export interface NotionMentionRichTextItem {
  type: "mention";
  mention:
    | { type: "user"; user: { id: string; name?: string } }
    | { type: "page"; page: { id: string } }
    | { type: "database"; database: { id: string } }
    | { type: "date"; date: { start: string; end: string | null } }
    | { type: "link_preview"; link_preview: { url: string } }
    | { type: "link_mention"; link_mention: { href: string } };
  annotations: NotionAnnotations;
  plain_text: string;
  href: string | null;
}

export interface NotionEquationRichTextItem {
  type: "equation";
  equation: { expression: string };
  annotations: NotionAnnotations;
  plain_text: string;
  href: string | null;
}

/** Annotation fields for a rich-text *request* object (all optional) */
export interface NotionAnnotationRequest {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
}

/** A single rich-text item sent *to* the Notion API */
export interface NotionRichTextRequest {
  type?: "text";
  text: { content: string; link?: { url: string } | null };
  annotations?: NotionAnnotationRequest;
}

// ---------------------------------------------------------------------------
// Webhook payload (sparse comment.created event)
// ---------------------------------------------------------------------------

export interface NotionWebhookPayload {
  type: string;
  data: {
    id: string;
    parent?: { type: string; page_id?: string; block_id?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
