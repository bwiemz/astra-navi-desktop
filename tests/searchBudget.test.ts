import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchEverywhere } from "../src/core/knowledge.ts";
import { SearchBudget } from "../src/core/searchBudget.ts";

/** The hosts her lookups were sent to. Nothing in these tests reaches the network. */
const asked: string[] = [];
vi.mock("../src/core/web.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  fetchJson: vi.fn((address: string) => {
    asked.push(new URL(address).host);
    return Promise.resolve(
      address.includes("api.search.brave.com")
        ? {
            web: { results: [{ title: "A page", url: "https://example.org/a", description: "x" }] },
          }
        : {},
    );
  }),
}));

let dir = "";
/** Every count made in a test, so its last save is on disk before the folder is removed. */
const made: SearchBudget[] = [];

function counting(file: string, limit: () => number, now?: () => Date): SearchBudget {
  const budget = new SearchBudget(file, limit, now);
  made.push(budget);
  return budget;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aichan-budget-"));
});
afterEach(async () => {
  asked.length = 0;
  await Promise.all(made.splice(0).map((budget) => budget.flush()));
  await rm(dir, { recursive: true, force: true });
});

describe("her monthly count of paid searches", () => {
  it("lets searches through up to the limit and no further", () => {
    const budget = counting(join(dir, "count.json"), () => 3);
    expect([budget.take(), budget.take(), budget.take(), budget.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(budget.status()).toEqual({ used: 3, limit: 3 });
  });

  it("treats a limit of 0 as no limit, and still counts", () => {
    const budget = counting(join(dir, "count.json"), () => 0);
    for (let index = 0; index < 50; index++) expect(budget.take()).toBe(true);
    expect(budget.status()).toEqual({ used: 50, limit: 0 });
  });

  it("starts again when the month changes", () => {
    let now = new Date(2026, 10, 30, 23, 59);
    const budget = counting(
      join(dir, "count.json"),
      () => 1,
      () => now,
    );
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    now = new Date(2026, 11, 1, 0, 1);
    expect(budget.status().used).toBe(0);
    expect(budget.take()).toBe(true);
  });

  it("remembers the count across restarts, in a file only the user can read", async () => {
    const file = join(dir, "count.json");
    const first = counting(file, () => 5);
    first.take();
    first.take();
    await first.flush();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const second = counting(file, () => 5);
    await second.load();
    expect(second.status().used).toBe(2);
  });

  it("does not carry last month's count out of the file", async () => {
    const file = join(dir, "count.json");
    await writeFile(file, JSON.stringify({ month: "2026-10", used: 999 }));
    const budget = counting(
      file,
      () => 1000,
      () => new Date(2026, 10, 21),
    );
    await budget.load();
    expect(budget.status().used).toBe(0);
  });

  it.each(["not json", JSON.stringify({ month: 5, used: "many" }), JSON.stringify({ used: -3 })])(
    "starts from nothing when the file holds %s",
    async (content) => {
      const file = join(dir, "count.json");
      await writeFile(file, content);
      const budget = counting(file, () => 10);
      await budget.load();
      expect(budget.status().used).toBe(0);
      expect(budget.take()).toBe(true);
      await budget.flush();
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ used: 1 });
    },
  );

  it("picks up a limit changed in the settings without a restart", () => {
    let limit = 1;
    const budget = counting(join(dir, "count.json"), () => limit);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    limit = 2;
    expect(budget.take()).toBe(true);
  });
});

describe("searching with an allowance", () => {
  it("asks Brave while the allowance lasts, and only the open sources after", async () => {
    const budget = counting(join(dir, "count.json"), () => 1);
    const setup = {
      language: "en" as const,
      linux: false,
      braveApiKey: "key",
      mayAskBrave: () => budget.take(),
    };
    const first = await searchEverywhere("best budget keyboard", setup);
    expect(asked).toContain("api.search.brave.com");
    expect(first.some((result) => result.url === "https://example.org/a")).toBe(true);
    asked.length = 0;
    await searchEverywhere("best budget mouse", setup);
    expect(asked).not.toContain("api.search.brave.com");
    expect(asked.length).toBeGreaterThan(0);
    expect(budget.status()).toEqual({ used: 1, limit: 1 });
  });

  it("does not count anything when no key is set", async () => {
    const budget = counting(join(dir, "count.json"), () => 5);
    await searchEverywhere("ships", {
      language: "en",
      linux: false,
      braveApiKey: null,
      mayAskBrave: () => budget.take(),
    });
    expect(asked).not.toContain("api.search.brave.com");
    expect(budget.status().used).toBe(0);
  });
});
