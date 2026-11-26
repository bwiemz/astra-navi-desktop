import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  htmlToText,
  pageLinks,
  parseSearchResults,
  WEB_USER_AGENT,
} from "../src/core/web.ts";

describe("WEB_USER_AGENT", () => {
  it("identifies Astra Navi Desktop rather than legacy AI-chan branding", () => {
    expect(WEB_USER_AGENT).toMatch(/^Astra-Navi-Desktop\//);
    expect(WEB_USER_AGENT).not.toContain("AI-chan");
  });
});

describe("htmlToText", () => {
  it("keeps the words and drops scripts, styles, menus and markup", () => {
    const html = `<html><head><title>Kdenlive &amp; you</title><style>p{color:red}</style></head>
      <body><nav>Home | About</nav><h1>Install</h1><p>Run <b>pacman</b> &mdash; done.</p>
      <script>alert("x")</script><ul><li>One</li><li>Two</li></ul><footer>(c)</footer></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Kdenlive & you");
    expect(text).toContain("Install");
    expect(text).toContain("Run pacman");
    expect(text).toContain("- One");
    expect(text).not.toMatch(/alert|color:red|Home \| About|<|\(c\)/);
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities and leaves unknown ones alone", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#39;d&#x27; &#8212; &bogus;")).toBe(
      "a & b <c> 'd' — &bogus;",
    );
  });
});

describe("parseSearchResults", () => {
  const page = `
    <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Farchlinux.org%2Fpackages%2Fextra%2Fx86_64%2Fkdenlive%2F&amp;rut=abc">Arch Linux - <b>kdenlive</b></a>
      <a class="result__snippet" href="#">A non-linear <b>video editor</b> for Linux</a></div>
    <div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example">Sponsored thing</a>
      <a class="result__snippet">Buy now</a></div>
    <div class="result"><a class="result__a" href="https://kdenlive.org/download/">Download | Kdenlive</a>
      <a class="result__snippet">Get Kdenlive</a></div>`;

  it("recovers the real addresses, titles and excerpts, and skips adverts", () => {
    expect(parseSearchResults(page)).toEqual([
      {
        title: "Arch Linux - kdenlive",
        url: "https://archlinux.org/packages/extra/x86_64/kdenlive/",
        snippet: "A non-linear video editor for Linux",
      },
      {
        title: "Download | Kdenlive",
        url: "https://kdenlive.org/download/",
        snippet: "Get Kdenlive",
      },
    ]);
  });

  it("returns nothing for a page without results", () => {
    expect(parseSearchResults("<html><body>Unusual traffic detected</body></html>")).toEqual([]);
  });
});

describe("htmlToText with marked main content", () => {
  it("reads only the main part when the page marks one", () => {
    const html = `<html><body><div class="menu"><ul><li>Home</li><li>Forums</li></ul></div>
      <main id="content"><h1>FFmpeg</h1><p>FFmpeg is a complete solution.</p><p>-</p></main><div>Sidebar links</div></body></html>`;
    expect(htmlToText(html)).toBe("FFmpeg\nFFmpeg is a complete solution.");
  });
});

describe("pageLinks", () => {
  const page = `<html><body>
    <nav><a href="https://elsewhere.example/menu">Menu item</a></nav>
    <main>
      <p>See the <a href="https://docs.example.org/lumen#intro">Lumen technical details</a>
      and <a href="/wiki/Other_page">another article here</a>.</p>
      <p><a href="https://docs.example.org/lumen">Lumen technical details</a>
      <a href="https://cite.example/1">[1]</a>
      <a href="https://icons.example/x"><img src="x.png"></a>
      <a href="javascript:alert(1)">Click this now</a>
      <a href="http://127.0.0.1:8080/admin">Local admin page</a>
      <a href="https://sources.example/paper.pdf">The original paper &amp; data</a></p>
    </main>
    <footer><a href="https://elsewhere.example/terms">Terms of use</a></footer>
  </body></html>`;

  it("keeps the content's links to other sites, once each, with their words", () => {
    expect(pageLinks(page, "https://en.wikipedia.org/wiki/Lumen")).toEqual([
      { text: "Lumen technical details", url: "https://docs.example.org/lumen" },
      { text: "The original paper & data", url: "https://sources.example/paper.pdf" },
    ]);
  });

  it("returns nothing for a page with no usable address or no links", () => {
    expect(pageLinks(page, "not a url")).toEqual([]);
    expect(pageLinks("<p>plain</p>", "https://a.example/")).toEqual([]);
  });

  it("stops at the limit", () => {
    const many = Array.from(
      { length: 30 },
      (_unused, i) => `<a href="https://s${i}.example/">Source number ${i}</a>`,
    ).join("");
    expect(pageLinks(many, "https://a.example/", 5)).toHaveLength(5);
  });
});

describe("pages built to waste time", () => {
  it.each([
    ["unclosed links", "<a href=x>".repeat(40_000)],
    ["unclosed tags", "<".repeat(400_000)],
    ["unclosed scripts", "<script>".repeat(50_000)],
    ["unclosed comments", "<!--".repeat(100_000)],
    ["many mains", "<main>".repeat(60_000)],
    ["unclosed titles", "<title>".repeat(50_000)],
    ["anchors without an end", '<a href="https://x.example/">text '.repeat(30_000)],
  ])("reads a page of %s quickly", (_name, page) => {
    const started = performance.now();
    htmlToText(page);
    pageLinks(page, "https://a.example/");
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("does not treat an entity named like a built-in as one", () => {
    expect(decodeEntities("&constructor; &toString; &amp;")).toBe("&constructor; &toString; &");
  });
});
