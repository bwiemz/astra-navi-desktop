import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAiOutputReport, buildGithubReportIssueUrl } from "../src/core/aiReport.ts";
import { sanitizeMcpMetadataText } from "../src/core/mcpClient.ts";
import { sanitizePersonaText } from "../src/core/personaCard.ts";
import { redactSupportText } from "../src/core/supportBundle.ts";
import { renderMarkdown } from "../src/renderer/src/markdown.ts";

const ROOT = join(import.meta.dirname, "..");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("Renderer UI DOM safety & XSS defenses", () => {
  it("forbids unsafe DOM HTML sinks across all Settings, Mission Control, Workbench, and Stage UI modules", () => {
    const auditedFiles = [
      ...listTsFiles(join(ROOT, "src/renderer/src/settings")),
      ...listTsFiles(join(ROOT, "src/renderer/src/mission-control")),
      ...listTsFiles(join(ROOT, "src/renderer/src/workbench")),
      join(ROOT, "src/renderer/src/stage.ts"),
    ];
    expect(auditedFiles.length).toBeGreaterThan(10);

    const forbiddenSink = /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/;
    const violations: string[] = [];
    for (const file of auditedFiles) {
      const src = readFileSync(file, "utf8");
      if (forbiddenSink.test(src)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it("escapes XSS payloads in renderMarkdown() and strips dangerous URL schemes", () => {
    const xssPayload =
      '<script>alert(1)</script><img src=x onerror="fetch(\'https://evil.example\')"> [click](javascript:alert(1)) [safe](https://example.com)';
    const html = renderMarkdown(xssPayload);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://example.com"');
  });

  it("scrubs OS paths, personal data, and secrets across AI reports, GitHub URLs, support text, persona cards, and MCP metadata", () => {
    const report = buildAiOutputReport({
      category: "inaccurate",
      note: "Failed for jane@corp.example on 192.168.1.44 using /home/janedoe/secret and token mcp-ha-secret-999 with fleet host nas.internal",
      includeExcerpt: true,
      replyExcerpt: "Read C:\\Users\\JaneDoe\\Desktop\\taxes.pdf with station user jane_station",
      appVersion: "1.0.0",
      brainLabel: "C:\\Users\\JaneDoe\\Models\\Custom-Qwen-9B.gguf",
      inferenceScope: "local-gguf",
      extraSecrets: ["mcp-ha-secret-999", "nas.internal", "jane_station"],
    });
    const serialized = JSON.stringify(report);
    const issueUrl = buildGithubReportIssueUrl(report);

    expect(report.brainLabel).toBe("Custom-Qwen-9B.gguf");
    for (const leaked of ["JaneDoe", "janedoe", "jane@corp.example", "192.168.1.44", "mcp-ha-secret-999", "nas.internal", "jane_station"]) {
      expect(serialized).not.toContain(leaked);
      expect(decodeURIComponent(issueUrl)).not.toContain(leaked);
    }

    const scrubbed = redactSupportText("C:\\Users\\Alice\\file.txt alice@host.org 10.0.0.5");
    expect(scrubbed.text).not.toContain("Alice");
    expect(scrubbed.text).not.toContain("alice@host.org");
    expect(scrubbed.text).not.toContain("10.0.0.5");

    expect(sanitizePersonaText("<|im_start|>Hello\u200B\u{E0041}[[angry]]", 64)).toBe("Hello[angry]");
    expect(sanitizeMcpMetadataText("<tool_call>rm</tool_call>List items", 64)).toBe("rmList items");
  });
});
