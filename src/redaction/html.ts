/** Simple HTML → text/Markdown conversion for itslearning content (spec 6.4, step 1). */
import { LABELS, type Labels } from "./labels";
import { isShareableUrl } from "./secrets";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  euro: "€",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bdquo: "„",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(s) || /&(#\d+|[a-z]+);/i.test(s);
}

/** Removes all tags, repeated until stable (a single pass can leave tags formed by overlapping fragments). */
function stripTags(input: string): string {
  let s = input;
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<[^>]+>/g, "");
  } while (s !== prev);
  return s;
}

export function htmlToText(html: string, labels: Labels = LABELS.en): string {
  let s = html;
  let prev: string;
  // Non-content: code, styles and page chrome (navigation, header, footer) of web pages.
  // Repeated until stable, so nested/overlapping constructs ("<scr<script></script>ipt>") cannot survive.
  do {
    prev = s;
    s = s.replace(/<(script|style|noscript|template|svg|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  } while (s !== prev);
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const text = stripTags(inner).trim();
    const url = decodeEntities(href);
    if (isShareableUrl(url)) return text && text !== url ? `[${text}](${url})` : url;
    return text;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<\/li>/gi, "");
  s = s.replace(/<\/(p|div|ul|ol|h[1-6]|tr|table|blockquote)>/gi, "\n");
  s = s.replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n${"#".repeat(Number(n))} `);
  s = s.replace(/<\/?(strong|b)>/gi, "**");
  s = s.replace(/<\/?(em|i)>/gi, "_");
  s = s.replace(/<img\b[^>]*>/gi, labels.image);
  s = stripTags(s);
  s = decodeEntities(s);
  return (
    s
      .replace(/\r\n?/g, "\n") // itslearning pages use CRLF
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/ *\n */g, "\n")
      // list item whose content starts on the next line ("-\ncontent") → "- content"
      .replace(/^- ?\n(?=[^\n#-])/gm, "- ")
      // empty list items (page layout lists)
      .replace(/^- ?$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
