import { describe, expect, it } from "vite-plus/test";
import {
  astToRichText,
  markdownToRichText,
  richTextToAst,
  richTextToMarkdown,
} from "./format-converter.js";
import type { NotionRichTextItem } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextItem(
  content: string,
  annotations: Partial<NotionRichTextItem["annotations"]> = {},
  link: { url: string } | null = null,
): NotionRichTextItem {
  return {
    type: "text" as const,
    text: { content, link },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
      ...annotations,
    },
    plain_text: content,
    href: link?.url ?? null,
  };
}

// ---------------------------------------------------------------------------
// richTextToMarkdown
// ---------------------------------------------------------------------------

describe("richTextToMarkdown", () => {
  it("returns empty string for empty array", () => {
    expect(richTextToMarkdown([])).toBe("");
  });

  it("converts plain text", () => {
    const result = richTextToMarkdown([makeTextItem("Hello world")]);
    expect(result.trim()).toBe("Hello world");
  });

  it("converts bold text", () => {
    const result = richTextToMarkdown([makeTextItem("bold", { bold: true })]);
    expect(result.trim()).toBe("**bold**");
  });

  it("converts italic text", () => {
    const result = richTextToMarkdown([makeTextItem("italic", { italic: true })]);
    expect(result.trim()).toBe("*italic*");
  });

  it("converts inline code", () => {
    const result = richTextToMarkdown([makeTextItem("code", { code: true })]);
    expect(result.trim()).toBe("`code`");
  });

  it("converts strikethrough", () => {
    const result = richTextToMarkdown([makeTextItem("deleted", { strikethrough: true })]);
    expect(result.trim()).toBe("~~deleted~~");
  });

  it("converts links", () => {
    const result = richTextToMarkdown([
      makeTextItem("click here", {}, { url: "https://example.com" }),
    ]);
    expect(result.trim()).toBe("[click here](https://example.com)");
  });

  it("handles combined bold + italic annotations", () => {
    const result = richTextToMarkdown([makeTextItem("both", { bold: true, italic: true })]);
    // Should contain both markers
    expect(result.trim()).toContain("**");
    expect(result.trim()).toContain("*");
    expect(result.trim()).toContain("both");
  });

  it("converts multiple items in sequence", () => {
    const result = richTextToMarkdown([
      makeTextItem("Hello "),
      makeTextItem("world", { bold: true }),
    ]);
    expect(result.trim()).toContain("Hello");
    expect(result.trim()).toContain("**world**");
  });

  it("converts mention (user)", () => {
    const mention: NotionRichTextItem = {
      type: "mention",
      mention: { type: "user", user: { id: "user-123", name: "Alice" } },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
      },
      plain_text: "Alice",
      href: null,
    };
    const result = richTextToMarkdown([mention]);
    expect(result.trim()).toContain("@Alice");
  });

  it("converts equation", () => {
    const equation: NotionRichTextItem = {
      type: "equation",
      equation: { expression: "E = mc^2" },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
      },
      plain_text: "E = mc^2",
      href: null,
    };
    const result = richTextToMarkdown([equation]);
    expect(result.trim()).toBe("`E = mc^2`");
  });
});

// ---------------------------------------------------------------------------
// markdownToRichText
// ---------------------------------------------------------------------------

describe("markdownToRichText", () => {
  it("converts plain text", () => {
    const items = markdownToRichText("Hello world");
    const texts = items.map((i) => i.text.content).join("");
    expect(texts).toContain("Hello world");
  });

  it("converts bold markdown", () => {
    const items = markdownToRichText("**bold**");
    const boldItem = items.find((i) => i.annotations?.bold);
    expect(boldItem).toBeDefined();
    expect(boldItem?.text.content).toBe("bold");
  });

  it("converts italic markdown", () => {
    const items = markdownToRichText("*italic*");
    const italicItem = items.find((i) => i.annotations?.italic);
    expect(italicItem).toBeDefined();
    expect(italicItem?.text.content).toBe("italic");
  });

  it("converts inline code", () => {
    const items = markdownToRichText("`code`");
    const codeItem = items.find((i) => i.annotations?.code);
    expect(codeItem).toBeDefined();
    expect(codeItem?.text.content).toBe("code");
  });

  it("converts strikethrough", () => {
    const items = markdownToRichText("~~deleted~~");
    const strikeItem = items.find((i) => i.annotations?.strikethrough);
    expect(strikeItem).toBeDefined();
    expect(strikeItem?.text.content).toBe("deleted");
  });

  it("converts links", () => {
    const items = markdownToRichText("[click](https://example.com)");
    const linkItem = items.find((i) => i.text.link?.url);
    expect(linkItem).toBeDefined();
    expect(linkItem?.text.link?.url).toBe("https://example.com");
    expect(linkItem?.text.content).toBe("click");
  });

  it("converts code blocks", () => {
    const items = markdownToRichText("```\nconsole.log('hi')\n```");
    const codeItem = items.find((i) => i.annotations?.code);
    expect(codeItem).toBeDefined();
    expect(codeItem?.text.content).toContain("console.log");
  });

  it("chunks text longer than 2000 characters", () => {
    const longText = "a".repeat(3000);
    const items = markdownToRichText(longText);
    // Should be split into at least 2 items
    const totalLength = items.reduce((sum, i) => sum + i.text.content.length, 0);
    expect(totalLength).toBeGreaterThanOrEqual(3000);
    for (const item of items) {
      expect(item.text.content.length).toBeLessThanOrEqual(2000);
    }
  });
});

// ---------------------------------------------------------------------------
// Roundtrip: markdown → richText → ast → markdown
// ---------------------------------------------------------------------------

describe("roundtrip", () => {
  it("preserves plain text through roundtrip", () => {
    const original = "Hello world";
    const richText = markdownToRichText(original);
    // Convert our request items to response-like items for richTextToMarkdown
    const responseItems: NotionRichTextItem[] = richText.map((item) => ({
      type: "text" as const,
      text: {
        content: item.text.content,
        link: item.text.link ? { url: item.text.link.url } : null,
      },
      annotations: {
        bold: item.annotations?.bold ?? false,
        italic: item.annotations?.italic ?? false,
        strikethrough: item.annotations?.strikethrough ?? false,
        underline: item.annotations?.underline ?? false,
        code: item.annotations?.code ?? false,
        color: "default",
      },
      plain_text: item.text.content,
      href: item.text.link?.url ?? null,
    }));
    const markdown = richTextToMarkdown(responseItems);
    expect(markdown.trim()).toContain("Hello world");
  });

  it("preserves bold through roundtrip", () => {
    const original = "**bold text**";
    const richText = markdownToRichText(original);
    const responseItems: NotionRichTextItem[] = richText.map((item) => ({
      type: "text" as const,
      text: {
        content: item.text.content,
        link: item.text.link ? { url: item.text.link.url } : null,
      },
      annotations: {
        bold: item.annotations?.bold ?? false,
        italic: item.annotations?.italic ?? false,
        strikethrough: item.annotations?.strikethrough ?? false,
        underline: item.annotations?.underline ?? false,
        code: item.annotations?.code ?? false,
        color: "default",
      },
      plain_text: item.text.content,
      href: item.text.link?.url ?? null,
    }));
    const markdown = richTextToMarkdown(responseItems);
    expect(markdown.trim()).toContain("**bold text**");
  });
});

// ---------------------------------------------------------------------------
// richTextToAst / astToRichText
// ---------------------------------------------------------------------------

describe("richTextToAst", () => {
  it("returns root with empty children for empty array", () => {
    const ast = richTextToAst([]);
    expect(ast.type).toBe("root");
    expect(ast.children).toHaveLength(0);
  });

  it("returns root with paragraph for text items", () => {
    const ast = richTextToAst([makeTextItem("hello")]);
    expect(ast.type).toBe("root");
    expect(ast.children.length).toBeGreaterThan(0);
    expect(ast.children[0].type).toBe("paragraph");
  });
});

describe("astToRichText", () => {
  it("converts a simple ast to rich text items", () => {
    const ast = richTextToAst([makeTextItem("hello")]);
    const items = astToRichText(ast);
    const text = items.map((i) => i.text.content).join("");
    expect(text).toContain("hello");
  });
});
