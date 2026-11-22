import { describe, expect, it } from "vitest";
import { linkHost, renderMarkdown } from "../src/renderer/src/markdown.ts";

describe("renderMarkdown", () => {
  it("escapes markup in the assistant's text", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> & <script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
  });

  it("renders bold, code and paragraphs", () => {
    expect(renderMarkdown("**Done.** Run `ls -la`\nnext line\n\nSecond")).toBe(
      "<p><strong>Done.</strong> Run <code>ls -la</code><br>next line</p><p>Second</p>",
    );
  });

  it("does not format inside inline code", () => {
    expect(renderMarkdown("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
  });

  it("renders bullet and numbered lists", () => {
    expect(renderMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(renderMarkdown("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  it("renders fenced code, including one that is still streaming", () => {
    expect(renderMarkdown("```sh\necho <hi>\n```")).toBe("<pre><code>echo &lt;hi&gt;</code></pre>");
    expect(renderMarkdown("```\nhalf")).toBe("<pre><code>half</code></pre>");
  });

  it("only links web addresses, and never as a live href", () => {
    const html = renderMarkdown("[site](https://example.com/a?b=1) [bad](javascript:alert(1))");
    expect(html).toContain(
      '<a href="#" data-href="https://example.com/a?b=1" title="https://example.com/a?b=1"><bdi>site</bdi></a>',
    );
    expect(html).not.toContain('data-href="javascript');
  });

  it("shows the real address when the link text pretends to be a different one", () => {
    const html = renderMarkdown("[https://bank.example](https://evil.example/login)");
    expect(html).toContain("><bdi>https://evil.example/login</bdi></a>");
    expect(html).not.toContain("https://bank.example<");
    expect(renderMarkdown("[bank.example](https://evil.example/)")).toContain(
      "><bdi>https://evil.example/</bdi></a>",
    );
    expect(renderMarkdown("[the Arch wiki](https://wiki.archlinux.org/)")).toContain(
      "><bdi>the Arch wiki</bdi></a>",
    );
  });

  it("names the site beside a link whose text is words", () => {
    expect(renderMarkdown("[the Arch wiki](https://wiki.archlinux.org/title/KDE)")).toContain(
      '><bdi>the Arch wiki</bdi></a><span class="link-host"> (<bdi>wiki.archlinux.org</bdi>)</span>',
    );
    // Not when the text is the address itself: that would only say it twice.
    expect(renderMarkdown("[https://example.com/a](https://example.com/a)")).not.toContain(
      "link-host",
    );
    expect(renderMarkdown("[bank.example](https://evil.example/)")).not.toContain("link-host");
  });

  it("names the site a browser would really go to", () => {
    // What comes before an @ is a user name, not the site.
    expect(renderMarkdown("[your bank](https://bank.example@evil.example/login)")).toContain(
      '<span class="link-host"> (<bdi>evil.example</bdi>)</span>',
    );
    expect(renderMarkdown("[x](https://EXAMPLE.com:8443/a?b=1&c=2)")).toContain(
      "(<bdi>example.com</bdi>)",
    );
    // Letters that only look like Latin ones come out in their plain spelling.
    expect(linkHost("https://\u0430pple.com/")).toBe("xn--pple-43d.com");
  });

  it("leaves an address nothing can make sense of as text, not as a link", () => {
    const html = renderMarkdown("[here](https://[not-an-address/)");
    expect(html).not.toContain("<a ");
    expect(html).toContain("here (https://[not-an-address/)");
    expect(linkHost("https://[not-an-address/")).toBeNull();
  });

  it("cannot break out of the link attribute", () => {
    const html = renderMarkdown('[x](https://example.com/"onmouseover="alert(1))');
    expect(html).not.toContain('"onmouseover="');
  });

  // Web text can carry characters that turn the order of what follows around. Left in a
  // link's words, they would redraw the name of the site that is shown beside it.
  it("takes the characters that turn text around out of everything she says", () => {
    const turned = "\u202Eevil\u202C \u2066x\u2069";
    const html = renderMarkdown(
      `before ${turned} [\u202Ebank\u202D](https://evil.example/a) after`,
    );
    expect(html).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(html).toContain("<bdi>bank</bdi></a>");
    expect(html).toContain('<span class="link-host"> (<bdi>evil.example</bdi>)</span>');
    expect(renderMarkdown("- \u202Eitem")).toBe("<ul><li>item</li></ul>");
  });

  it("takes characters that draw nothing out of a link's words", () => {
    const html = renderMarkdown("[my\u200B \u200Fbank\u00AD\u0007\uFEFF](https://evil.example/)");
    expect(html).toContain("<bdi>my bank</bdi></a>");
    // Words made of nothing but such characters would be a link nobody can see: the address is shown.
    expect(renderMarkdown("[\u200B\u200E](https://evil.example/)")).toContain(
      "<bdi>https://evil.example/</bdi></a>",
    );
    // And they cannot hide an address inside the words, so that it is taken for honest ones.
    expect(renderMarkdown("[bank\u200B.example](https://evil.example/)")).toContain(
      "<bdi>https://evil.example/</bdi></a>",
    );
  });

  it("does not make a link of an address with unseen characters in it", () => {
    for (const address of [
      "https://evil.example/\u200Ba",
      "https://exam\u00ADple.com/",
      "https://example.com/\u0001",
    ]) {
      const html = renderMarkdown(`[here](${address})`);
      expect(html, JSON.stringify(address)).not.toContain("<a ");
      for (const unseen of ["\u0001", "\u00AD", "\u200B"]) expect(html).not.toContain(unseen);
    }
    // A character that turns text around is gone before the address is read, so the link
    // that is made leads where its tooltip says, spelled the way it is drawn.
    const turned = renderMarkdown("[here](https://example.com/\u202Egnp.exe)");
    expect(turned).toContain(
      'data-href="https://example.com/gnp.exe" title="https://example.com/gnp.exe"',
    );
  });

  it("sets the site's name apart from the direction of the words around it", () => {
    // Hebrew words for a link: the site beside them still reads left to right.
    const html = renderMarkdown("[\u05D1\u05E0\u05E7](https://evil.example/)");
    expect(html).toContain("<bdi>\u05D1\u05E0\u05E7</bdi></a>");
    expect(html).toContain("(<bdi>evil.example</bdi>)");
  });

  // Bold and italics used to run over the finished link, address and all.
  it("never formats inside a link's address", () => {
    const address = "https://x.example/a**b**c";
    const html = renderMarkdown(`[docs](${address}) and **bold**`);
    expect(html).toContain(`data-href="${address}" title="${address}"`);
    expect(html).toContain("<strong>bold</strong>");
    expect(html.match(/<strong>/g)).toHaveLength(1);

    const starred = renderMarkdown(
      "see *[a](https://x.example/*one*) and [b](https://x.example/*two*)*",
    );
    expect(starred).toContain('data-href="https://x.example/*one*"');
    expect(starred).toContain('data-href="https://x.example/*two*"');
    expect(starred).not.toMatch(/data-href="[^"]*</);
  });

  it("keeps two links' markup whole when stars sit in both addresses", () => {
    const html = renderMarkdown("[a](https://x.example/**1) then [b](https://x.example/**2)");
    expect(html).toContain('data-href="https://x.example/**1"');
    expect(html).toContain('data-href="https://x.example/**2"');
    expect(html).not.toContain("<strong>");
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html.match(/<\/a>/g)).toHaveLength(2);
  });

  it("still formats a link's words, and a code span among them", () => {
    const html = renderMarkdown("[**the** `pacman` page](https://wiki.archlinux.org/title/Pacman)");
    expect(html).toContain("<bdi><strong>the</strong> <code>pacman</code> page</bdi></a>");
    expect(html).toContain('data-href="https://wiki.archlinux.org/title/Pacman"');
  });

  it("does not make a link of an address with a code span in it", () => {
    const html = renderMarkdown("[x](https://e.example/`a`)");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("data-href");
    expect(html).toContain("<code>a</code>");
  });

  it("leaves nothing of its own marks behind", () => {
    const html = renderMarkdown("\uE0000\uE000 `a` [x](https://e.example/) \uE0005\uE000");
    expect(html).not.toContain("\uE000");
    expect(html.match(/<code>/g)).toHaveLength(1);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("names the real site beside an address that is written to look like another", () => {
    // Cyrillic letters that look like "apple": shown as written, it would pass for it.
    const lookAlike = "https://аррӏе.com/login";
    for (const source of [`[${lookAlike}](${lookAlike})`, `[apple.com](${lookAlike})`]) {
      const html = renderMarkdown(source);
      expect(html).toContain(`data-href="${lookAlike}"`);
      expect(html).toContain('<span class="link-host"> (<bdi>xn--80ak6aa92e.com</bdi>)</span>');
    }
    // A name in front of an @, and a number that is really an address.
    expect(
      renderMarkdown("[https://bank.example@evil.example/](https://bank.example@evil.example/)"),
    ).toContain("(<bdi>evil.example</bdi>)");
    expect(renderMarkdown("[http://2130706433/](http://2130706433/)")).toContain(
      "(<bdi>127.0.0.1</bdi>)",
    );
  });

  it("does not say an honest address twice, whatever its capitals or port", () => {
    for (const address of [
      "https://example.com/a",
      "https://Example.COM/a",
      "https://example.com:8443/a?b=1",
      "http://192.168.1.10:8006",
    ]) {
      expect(renderMarkdown(`[${address}](${address})`), address).not.toContain("link-host");
    }
  });

  it("takes the characters that turn text around out of fenced code too", () => {
    const html = renderMarkdown("```\nrm -rf ‮fdp.txt‬ build ⁦x⁩\n```");
    expect(html).toBe("<pre><code>rm -rf fdp.txt build x</code></pre>");
    // Everything else in a fence stays letter for letter.
    expect(renderMarkdown("```\n  a  <b> &amp; **c**\n```")).toBe(
      "<pre><code>  a  &lt;b&gt; &amp;amp; **c**</code></pre>",
    );
  });
});
