import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeFound, findFiles, isDocument, readDocument } from "../src/core/documents.ts";
import {
  describeWeather,
  keyTerms,
  readArchWiki,
  readBrave,
  readHackerNews,
  readInstantAnswer,
  readSearxng,
  readStackOverflow,
  readWikipedia,
} from "../src/core/knowledge.ts";
import { TOOLS, toolVerdict } from "../src/core/permissions.ts";
import { describeRequest } from "../src/core/requestWords.ts";

describe("reading what the open sources send back", () => {
  it("reads Wikipedia's search results and strips the highlighting", () => {
    const results = readWikipedia(
      {
        pages: [
          {
            key: "Unreal_Engine_5",
            title: "Unreal Engine 5",
            description: "Game engine",
            excerpt: 'a demo called &quot;<span class="searchmatch">Lumen</span> in the Land',
          },
        ],
      },
      "en.wikipedia.org",
    );
    expect(results).toEqual([
      {
        title: "Unreal Engine 5",
        url: "https://en.wikipedia.org/wiki/Unreal_Engine_5",
        snippet: 'Game engine: a demo called "Lumen in the Land',
        source: "Wikipedia",
      },
    ]);
  });

  it("reads an instant answer and its summary", () => {
    const results = readInstantAnswer({
      Answer: "",
      AbstractText: "The speed of light in vacuum is exactly 299792458 m/s.",
      AbstractURL: "https://en.wikipedia.org/wiki/Speed_of_light",
      AbstractSource: "Wikipedia",
      Heading: "Speed of light",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: "Speed of light", source: "Wikipedia" });
    expect(readInstantAnswer({ Answer: "42", AbstractText: "" })[0]?.snippet).toBe("42");
  });

  it("keeps only answered Stack Overflow questions with a real address", () => {
    const results = readStackOverflow({
      items: [
        {
          title: "Trim &amp; keep quality",
          link: "https://stackoverflow.com/q/1",
          is_answered: true,
          score: 12,
          tags: ["ffmpeg"],
        },
        {
          title: "Unanswered",
          link: "https://stackoverflow.com/q/2",
          is_answered: false,
          score: 5,
          tags: [],
        },
        {
          title: "Elsewhere",
          link: "https://evil.example/q/3",
          is_answered: true,
          score: 5,
          tags: [],
        },
      ],
    });
    expect(results.map((result) => result.title)).toEqual(["Trim & keep quality"]);
  });

  it("reads the Arch wiki, Hacker News, SearXNG and Brave", () => {
    expect(
      readArchWiki([
        "pipewire",
        ["Pipewire", "PipeWire", "PipeWire (Italiano)"],
        ["", "", ""],
        [
          "https://wiki.archlinux.org/title/Pipewire",
          "https://wiki.archlinux.org/title/PipeWire",
          "https://wiki.archlinux.org/title/PipeWire_(Italiano)",
        ],
      ]).map((result) => result.url),
    ).toEqual(["https://wiki.archlinux.org/title/Pipewire"]);
    expect(
      readHackerNews({
        hits: [
          {
            title: "Show HN",
            url: "",
            objectID: "9",
            created_at: "2026-11-01T00:00:00Z",
            points: 7,
          },
        ],
      })[0]?.url,
    ).toBe("https://news.ycombinator.com/item?id=9");
    expect(
      readSearxng({
        results: [
          { title: "A", url: "https://a.example", content: "x" },
          { title: "B", url: "javascript:1" },
        ],
      }),
    ).toHaveLength(1);
    expect(
      readBrave({
        web: {
          results: [{ title: "A", url: "https://a.example", description: "<strong>x</strong>" }],
        },
      })[0]?.snippet,
    ).toBe("x");
  });

  it("returns nothing, not an error, for an answer in an unexpected shape", () => {
    for (const read of [
      readInstantAnswer,
      readStackOverflow,
      readArchWiki,
      readHackerNews,
      readSearxng,
      readBrave,
    ]) {
      for (const body of [null, "text", [], {}, { items: "no", hits: 3, query: 1, web: [] }]) {
        expect(read(body)).toEqual([]);
      }
    }
    expect(readWikipedia(null, "en.wikipedia.org")).toEqual([]);
  });
});

describe("keyTerms", () => {
  it.each([
    [
      "how does PipeWire differ from PulseAudio on Linux, and is there any reason to still run PulseAudio today",
      "PipeWire PulseAudio Linux",
    ],
    ["PipeWire vs PulseAudio differences", "PipeWire PulseAudio"],
    ["What is Lumen in Unreal Engine 5", "Lumen Unreal Engine 5"],
    ["ffmpeg trim video without re-encoding", "ffmpeg trim video without"],
    ["speed of light", "speed light"],
    ["kdenlive", "kdenlive"],
    ["京都の天気", "京都の天気"],
    ["how is it", "how is it"],
  ])("reduces %s to %s", (question, terms) => {
    expect(keyTerms(question)).toBe(terms);
  });
});

describe("describeWeather", () => {
  it("writes the conditions in both scales, day by day", () => {
    const report = describeWeather("Kyoto, Japan", {
      current: {
        temperature_2m: 11,
        apparent_temperature: 9.4,
        relative_humidity_2m: 55,
        weather_code: 0,
        wind_speed_10m: 9.2,
      },
      daily: {
        time: ["2026-11-21", "2026-11-22", "2026-11-23"],
        weather_code: [0, 61, 71],
        temperature_2m_max: [14, 12, 3],
        temperature_2m_min: [5, 7, -1],
        precipitation_probability_max: [0, 80, 60],
      },
    });
    expect(report).toContain(
      "Now: 11°C (52°F), feels like 9°C (49°F), clear, wind 9 km/h, humidity 55%.",
    );
    expect(report).toContain(
      "Tomorrow (Sunday 2026-11-22): light rain, 7°C (45°F) to 12°C (54°F), 80% chance of rain or snow.",
    );
    expect(report).toContain("Monday 2026-11-23: light snow, -1°C (30°F) to 3°C (37°F)");
  });

  it("refuses an answer it cannot read", () => {
    expect(() => describeWeather("X", { error: true })).toThrow(/unreadable/);
  });
});

describe("documents and finding files", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aichan-docs-"));
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "tax-2025.txt"), "Total owed: 1200 dollars");
    await writeFile(join(dir, "sub", "Tax Notes.md"), "Remember the heron receipt");
    await writeFile(join(dir, "recipe.txt"), "Pasta with garlic");
    await mkdir(join(dir, ".ssh"));
    await writeFile(join(dir, ".ssh", "tax_key"), "secret");
    await utimes(join(dir, "tax-2025.txt"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds files by part of the name, newest first, and never in private folders", async () => {
    const found = await findFiles({ name: "tax", folder: dir });
    expect(found.map((file) => file.path)).toEqual([
      join(dir, "sub", "Tax Notes.md"),
      join(dir, "tax-2025.txt"),
    ]);
    expect(describeFound(found)).toContain("tax-2025.txt (1 kB, changed 2020-01-01)");
  });

  it("finds files by a pattern and by what is written in them", async () => {
    expect((await findFiles({ name: "*.md", folder: dir })).map((file) => file.path)).toEqual([
      join(dir, "sub", "Tax Notes.md"),
    ]);
    expect((await findFiles({ content: "heron", folder: dir })).map((file) => file.path)).toEqual([
      join(dir, "sub", "Tax Notes.md"),
    ]);
    expect(await findFiles({ content: "no such words here", folder: dir })).toEqual([]);
  });

  it("treats a file name as a name, never as an option or a pattern to run", async () => {
    expect(await findFiles({ name: "--exec", folder: dir })).toEqual([]);
    expect(await findFiles({ name: "tax.2025", folder: dir })).toEqual([]); // a dot is a dot
    await expect(findFiles({ folder: dir })).rejects.toThrow(/name/);
  });

  it("knows which files it can read as documents", () => {
    for (const name of ["a.pdf", "b.DOCX", "c.odt", "d.xlsx", "shot.png"])
      expect(isDocument(name)).toBe(true);
    for (const name of ["a.txt", "b.ts", "c.mp4", "noext"]) expect(isDocument(name)).toBe(false);
  });

  it("reads the text of a PDF it made itself", async () => {
    // A minimal one-page PDF saying "Hello heron".
    const pdf = [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
      "4 0 obj<</Length 44>>stream",
      "BT /F1 18 Tf 20 50 Td (Hello heron) Tj ET",
      "endstream endobj",
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
      "trailer<</Root 1 0 R>>",
      "%%EOF",
    ].join("\n");
    await writeFile(join(dir, "hello.pdf"), pdf);
    const document = await readDocument(join(dir, "hello.pdf"));
    expect(document.text).toContain("Hello heron");
    await expect(readDocument(join(dir, "recipe.txt"))).rejects.toThrow(/not a kind of document/);
  });
});

describe("rules for the knowledge tools", () => {
  const context = { workspace: "/home/sam/Documents/AI-chan", home: "/home/sam" };

  it("lets sums and weather through and looks through the home folder freely", async () => {
    expect(await toolVerdict(TOOLS.calculate, { expression: "2+2" }, context)).toEqual({
      decision: "allow",
    });
    expect(await toolVerdict(TOOLS.weather, { place: "Kyoto" }, context)).toEqual({
      decision: "allow",
    });
    expect(await toolVerdict(TOOLS.findFiles, { name: "tax" }, context)).toEqual({
      decision: "allow",
    });
    expect(await toolVerdict(TOOLS.findFiles, { name: "x", folder: "~/Videos" }, context)).toEqual({
      decision: "allow",
    });
  });

  it("asks before searching outside home or in a private folder", async () => {
    expect(
      await toolVerdict(TOOLS.findFiles, { name: "passwd", folder: "/etc" }, context),
    ).toMatchObject({
      decision: "ask",
      sensitive: false,
    });
    expect(
      await toolVerdict(TOOLS.findFiles, { name: "id", folder: "~/.ssh" }, context),
    ).toMatchObject({
      decision: "ask",
      sensitive: true,
    });
  });

  it("describes a file search plainly", () => {
    expect(describeRequest(TOOLS.findFiles, { name: "tax", folder: "/etc" })).toEqual({
      title: "Look for files here?",
      detail: "/etc",
      note: 'named like "tax"',
    });
  });
});
