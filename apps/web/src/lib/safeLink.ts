// Only http(s) URLs render as clickable links. Other schemes — javascript:,
// data:, file:, etc. — collapse to plain text so untrusted content (chat
// markdown, or a rib's board-view payload) can't smuggle an auto-executing
// link into the app origin.
export const isSafeLinkScheme = (href: unknown): href is string =>
  typeof href === "string" && /^https?:\/\//i.test(href);
