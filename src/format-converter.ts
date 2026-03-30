import type { Content, Root } from "chat";
import {
  emphasis,
  inlineCode,
  link,
  paragraph,
  parseMarkdown,
  root,
  strikethrough,
  stringifyMarkdown,
  strong,
  text,
} from "chat";
import type {
  NotionAnnotationRequest,
  NotionAnnotations,
  NotionRichTextItem,
  NotionRichTextRequest,
} from "./types.js";

// ---------------------------------------------------------------------------
// Notion rich-text → Markdown (via mdast)
// ---------------------------------------------------------------------------

/**
 * Convert an array of Notion rich-text items into a Markdown string.
 */
export function richTextToMarkdown(richText: NotionRichTextItem[]): string {
  if (richText.length === 0) return "";
  const ast = richTextToAst(richText);
  return stringifyMarkdown(ast);
}

/**
 * Convert an array of Notion rich-text items into an mdast Root.
 */
export function richTextToAst(richText: NotionRichTextItem[]): Root {
  if (richText.length === 0) return root([]);

  const children: Content[] = [];

  for (const item of richText) {
    children.push(richTextItemToNode(item));
  }

  return root([paragraph(children)]);
}

function richTextItemToNode(item: NotionRichTextItem): Content {
  let node: Content;

  switch (item.type) {
    case "mention":
      node = mentionToNode(item);
      break;
    case "equation":
      // Render LaTeX equations as inline code
      node = inlineCode(item.equation.expression);
      break;
    default:
      node = textItemToNode(item);
      break;
  }

  return node;
}

function textItemToNode(item: NotionRichTextItem): Content {
  const annotations: NotionAnnotations = item.type === "text" ? item.annotations : item.annotations;

  let node: Content = text(item.plain_text);

  // Apply link first (wraps text)
  if (item.type === "text" && item.text.link) {
    node = link(item.text.link.url, [text(item.plain_text)]);
  } else if (item.href) {
    node = link(item.href, [text(item.plain_text)]);
  }

  // Apply annotations inside-out
  if (annotations.code) {
    node = inlineCode(item.plain_text);
  } else {
    if (annotations.bold) {
      node = strong([node]);
    }
    if (annotations.italic) {
      node = emphasis([node]);
    }
    if (annotations.strikethrough) {
      node = strikethrough([node]);
    }
  }

  return node;
}

function mentionToNode(item: NotionRichTextItem): Content {
  if (item.type !== "mention") return text(item.plain_text);

  const m = item.mention;
  switch (m.type) {
    case "user":
      return text(`@${item.plain_text}`);
    case "page":
      return item.href ? link(item.href, [text(item.plain_text)]) : text(item.plain_text);
    case "database":
      return item.href ? link(item.href, [text(item.plain_text)]) : text(item.plain_text);
    case "date":
      return text(item.plain_text);
    case "link_preview":
      return link(m.link_preview.url, [text(item.plain_text)]);
    case "link_mention":
      return link(m.link_mention.href, [text(item.plain_text)]);
    default:
      return text(item.plain_text);
  }
}

// ---------------------------------------------------------------------------
// Markdown → Notion rich-text request items
// ---------------------------------------------------------------------------

/** Maximum characters per Notion rich-text item */
const MAX_RICH_TEXT_LENGTH = 2000;

/**
 * Convert a Markdown string into an array of Notion rich-text request items.
 */
export function markdownToRichText(markdown: string): NotionRichTextRequest[] {
  const ast = parseMarkdown(markdown);
  return astToRichText(ast);
}

/**
 * Convert an mdast Root into an array of Notion rich-text request items.
 */
export function astToRichText(ast: Root): NotionRichTextRequest[] {
  const items: NotionRichTextRequest[] = [];

  for (const child of ast.children) {
    walkNode(child, {}, items);
  }

  return items;
}

interface AnnotationState {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

function walkNode(
  node: Content,
  annotations: AnnotationState,
  items: NotionRichTextRequest[],
): void {
  switch (node.type) {
    case "paragraph":
      for (const child of node.children) {
        walkNode(child, annotations, items);
      }
      // Add trailing newline between paragraphs
      pushTextItem("\n", {}, items);
      break;

    case "text":
      pushTextItem(node.value, annotations, items);
      break;

    case "strong":
      for (const child of node.children) {
        walkNode(child, { ...annotations, bold: true }, items);
      }
      break;

    case "emphasis":
      for (const child of node.children) {
        walkNode(child, { ...annotations, italic: true }, items);
      }
      break;

    case "delete":
      for (const child of node.children) {
        walkNode(child, { ...annotations, strikethrough: true }, items);
      }
      break;

    case "inlineCode":
      pushTextItem(node.value, { ...annotations, code: true }, items);
      break;

    case "code":
      // Fenced code block → plain text with code annotation
      pushTextItem(`${node.value}\n`, { code: true }, items);
      break;

    case "link":
      pushLinkItem(node, annotations, items);
      break;

    case "heading": {
      for (const child of node.children) {
        walkNode(child, { ...annotations, bold: true }, items);
      }
      pushTextItem("\n", {}, items);
      break;
    }

    case "list": {
      for (let i = 0; i < node.children.length; i++) {
        const li = node.children[i];
        const bullet = node.ordered ? `${(node.start ?? 1) + i}. ` : "• ";
        pushTextItem(bullet, annotations, items);
        if (li.type === "listItem") {
          for (const child of li.children) {
            walkNode(child, annotations, items);
          }
        }
      }
      break;
    }

    case "blockquote":
      for (const child of node.children) {
        walkNode(child, annotations, items);
      }
      break;

    default:
      // Fallback: try to extract children
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          walkNode(child as Content, annotations, items);
        }
      } else if ("value" in node && typeof node.value === "string") {
        pushTextItem(node.value, annotations, items);
      }
      break;
  }
}

function pushTextItem(
  content: string,
  annotations: AnnotationState,
  items: NotionRichTextRequest[],
): void {
  const chunks = chunkText(content);
  for (const chunk of chunks) {
    items.push({
      type: "text",
      text: { content: chunk },
      annotations: toAnnotationRequest(annotations),
    });
  }
}

function pushLinkItem(
  node: { url: string; children: Content[] },
  annotations: AnnotationState,
  items: NotionRichTextRequest[],
): void {
  // Flatten link text content
  const parts: string[] = [];
  collectText(node.children, parts);
  const linkText = parts.join("") || node.url;

  const chunks = chunkText(linkText);
  for (const chunk of chunks) {
    items.push({
      type: "text",
      text: { content: chunk, link: { url: node.url } },
      annotations: toAnnotationRequest(annotations),
    });
  }
}

function collectText(nodes: Content[], parts: string[]): void {
  for (const n of nodes) {
    if ("value" in n && typeof n.value === "string") {
      parts.push(n.value);
    } else if ("children" in n && Array.isArray(n.children)) {
      collectText(n.children as Content[], parts);
    }
  }
}

function toAnnotationRequest(state: AnnotationState): NotionAnnotationRequest | undefined {
  const a: NotionAnnotationRequest = {};
  let hasAny = false;
  if (state.bold) {
    a.bold = true;
    hasAny = true;
  }
  if (state.italic) {
    a.italic = true;
    hasAny = true;
  }
  if (state.strikethrough) {
    a.strikethrough = true;
    hasAny = true;
  }
  if (state.code) {
    a.code = true;
    hasAny = true;
  }
  return hasAny ? a : undefined;
}

/**
 * Split a string into chunks of at most MAX_RICH_TEXT_LENGTH characters.
 */
function chunkText(content: string): string[] {
  if (content.length <= MAX_RICH_TEXT_LENGTH) return [content];
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += MAX_RICH_TEXT_LENGTH) {
    chunks.push(content.slice(i, i + MAX_RICH_TEXT_LENGTH));
  }
  return chunks;
}
