/**
 * Just enough Markdown for a speech balloon: paragraphs, lists, bold, italics, inline
 * code, fenced code and links. Everything is escaped first, so the assistant's text
 * (which can quote web pages) can never inject markup.
 */

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The site an address leads to, ready to show beside a link's words. It is read the way
 * a browser reads it, so "https://bank.example@evil.example/" names evil.example and a
 * name written in look-alike letters comes out in its plain "xn--" spelling.
 * `escapedUrl` has already been through escapeHtml, and so has the answer.
 */
export function linkHost(escapedUrl: string): string | null {
  const url = escapedUrl
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
  try {
    const { hostname } = new URL(url);
    return hostname === "" ? null : escapeHtml(hostname);
  } catch {
    return null;
  }
}

/**
 * The site an address names as it is written, for comparing with where it really leads:
 * everything between the "//" and the path, without a port, in small letters.
 */
function writtenHost(escapedUrl: string): string {
  const written = /^https?:\/\/([^/?#]*)/i.exec(escapedUrl)?.[1] ?? "";
  return written.replace(/:\d*$/, "").toLowerCase();
}

/** A private-use character that cannot appear in the text once it has been stripped below. */
const MARK = "\uE000";
const MARKED_SPAN = /\uE000(\d+)\uE000/g;

/**
 * Characters that turn the order of the text around them, or cut it off from its
 * surroundings. Web text can carry them, and one left open in her reply would redraw
 * what comes after it, the name of a link's site included. They are taken out of
 * everything she says.
 */
const TURNS_TEXT_AROUND = /[\u202A-\u202E\u2066-\u2069]/g;
/**
 * Characters that draw nothing at all. In a link's words or its address they can only
 * be there to mislead, so there they are taken out too.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this looks for
const DRAWS_NOTHING = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/** Bold and italics. Only ever run over words, never over markup that holds an address. */
function emphasised(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, "$1<em>$2</em>");
}

function renderInline(escaped: string): string {
  /** Finished pieces of markup, kept out of the text so no later rule can format inside them. */
  const lifted: string[] = [];
  const lift = (html: string): string => {
    lifted.push(html);
    return `${MARK}${lifted.length - 1}${MARK}`;
  };
  let text = escaped
    .replaceAll(MARK, "")
    .replace(TURNS_TEXT_AROUND, "")
    .replace(/`([^`\n]+)`/g, (_match, code: string) => lift(`<code>${code}</code>`));
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (whole: string, rawLabel: string, url: string) => {
      // An address with a code span lifted out of it, or with characters in it that
      // cannot be seen, is not one to send anybody to: it stays the text it is.
      if (url.includes(MARK) || url.replace(DRAWS_NOTHING, "") !== url) {
        return whole.replace(DRAWS_NOTHING, "");
      }
      const label = rawLabel.replace(DRAWS_NOTHING, "");
      // Link text that itself looks like an address must not disagree with the real one.
      const looksLikeAddress = /^\s*(https?:\/\/|www\.)|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(
        label.trim(),
      );
      const shown = label.trim() === "" || (looksLikeAddress && label.trim() !== url) ? url : label;
      const host = linkHost(url);
      // An address nothing can make sense of is left as the text it is, not made a link.
      if (host === null) return `${label} (${url})`;
      // Words for a link say nothing about where it leads, so the site is named beside them.
      // The name is set apart from the direction of the words around it.
      // An address shown as it is names its own site, unless the name as written is not
      // the name a browser goes to: look-alike letters, a "name@" in front, a number
      // that is really an address. Then the site is named beside it all the same.
      const beside =
        shown === url && writtenHost(url) === host
          ? ""
          : `<span class="link-host"> (<bdi>${host}</bdi>)</span>`;
      // Built whole and put aside: bold and italics below must not reach into the address.
      const words = shown === url ? url : emphasised(shown);
      return lift(`<a href="#" data-href="${url}" title="${url}"><bdi>${words}</bdi></a>${beside}`);
    },
  );
  text = emphasised(text);
  // A link's words can hold a code span, so what is put back may hold a mark of its own.
  for (let depth = 0; depth < 3 && text.includes(MARK); depth++) {
    text = text.replace(MARKED_SPAN, (_match, index: string) => lifted[Number(index)] ?? "");
  }
  return text.replaceAll(MARK, "");
}

export function renderMarkdown(source: string): string {
  const html: string[] = [];
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map((line) => renderInline(escapeHtml(line))).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    html.push(
      `<${tag}>${list.items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join("")}</${tag}>`,
    );
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      i += 1;
      // An unclosed fence (still streaming) simply runs to the end of the text.
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      // Code is shown letter for letter, except for what would redraw the letters
      // around it: a command must read the way it would run.
      html.push(
        `<pre><code>${escapeHtml(code.join("\n").replace(TURNS_TEXT_AROUND, ""))}</code></pre>`,
      );
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushParagraph();
      const ordered = numbered !== null && bullet === null;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item[1] ?? "");
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line.replace(/^#{1,6}\s+/, ""));
  }
  flushParagraph();
  flushList();
  return html.join("");
}
