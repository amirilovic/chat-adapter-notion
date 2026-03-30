# chat-adapter-notion

ChatSDK adapter for Notion. Enables using Notion page comments as a chat channel.

## Project

Standalone TypeScript package. Biome linter, Vitest test runner.

## Commands

- `pnpm lint` — Biome check
- `pnpm typecheck` — TypeScript type checking
- `pnpm test` — Vitest (all tests)
- `pnpm build` — Build to dist/

## Architecture

- **Thread mapping**: Notion page = thread, page comments = messages, discussion threads = sub-threads
- **Thread ID format**: `notion:{base64url(pageId)}:{base64url(discussionId)}`
- **Webhook flow**: Verify HMAC signature → parse sparse `comment.created` event → fetch full comment via API → convert to ChatMessage → `processMessage()`
- **Outbound**: Convert markdown → Notion rich text → `comments.create()`
- **Limitations**: Notion API cannot edit/delete comments, no reactions, no typing indicators — these are graceful no-ops

## Key References

- ChatSDK adapter contributing guide: https://chat-sdk.dev/docs/contributing/building
- Notion Comments API: https://developers.notion.com/reference/create-a-comment
- Notion Webhooks: https://developers.notion.com/reference/webhooks

## Testing Strategy

- **Unit tests**: `*.test.ts` — colocated with source, no I/O
- Tests cover: format conversion (Notion rich text ↔ markdown), webhook signature verification, thread ID encoding/decoding, adapter method behavior
