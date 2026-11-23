import type { ShownTrace } from "../../../core/trace.ts";
import { bridge, element } from "./dom.ts";

/** A line of plain text in an element of its own. Never markup: what she and her tools wrote is shown as written. */
function line(tag: string, className: string, text: string): HTMLElement {
  const made = document.createElement(tag);
  if (className) made.className = className;
  made.textContent = text;
  return made;
}

function seconds(ms: number): string {
  return ms < 950 ? `${Math.round(ms / 10) * 10} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function tokensLine(tokens: ShownTrace["tokens"]): string {
  const { read, written, held, prompt } = tokens;
  const promptPart =
    typeof prompt === "number" ? `Prompt ${prompt.toLocaleString()} tokens. ` : "";
  if (read === null || written === null || held === null) {
    return `${promptPart}Read/written/held token counts are not known.`;
  }
  return `${promptPart}She read ${read.toLocaleString()} tokens, wrote ${written.toLocaleString()}, and held ${held.toLocaleString()} at the end.`;
}

function latenciesLine(ms: ShownTrace["ms"]): string {
  const stage = (label: string, value: number | null | undefined): string =>
    typeof value === "number" ? `${label}: ${seconds(value)}` : `${label}: n/a`;
  return [
    stage("STT", ms.stt),
    stage("LLM", ms.llm),
    stage("Tools", ms.tools),
    stage("TTS", ms.tts),
    ms.firstWord === null ? "First word: none" : `First word: ${seconds(ms.firstWord)}`,
    `Total: ${seconds(ms.whole)}`,
  ].join(" · ");
}

const ASKED_BY: Record<ShownTrace["kind"], string> = {
  user: "You said",
  ship: "The ship told her",
  again: "The app sent her back with",
};

function traceRow(trace: ShownTrace): HTMLLIElement {
  const item = document.createElement("li");
  const fold = document.createElement("details");
  fold.className = "trace";
  const head = document.createElement("summary");
  const when = new Date(trace.at);
  head.append(
    line(
      "span",
      "trace-time",
      Number.isNaN(when.getTime())
        ? ""
        : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    ),
    line("span", "trace-said", trace.kind === "again" ? "(her second go)" : trace.said),
    line("span", "trace-how", trace.summary),
  );
  fold.append(head);

  const body = document.createElement("div");
  body.className = "trace-body";
  body.append(line("p", "trace-label", ASKED_BY[trace.kind]), line("p", "trace-text", trace.said));
  body.append(line("p", "trace-label", "She said"));
  if (trace.withheld) {
    body.append(
      line("p", "trace-quiet", "Part of this reply is never written down and is not shown."),
    );
  }
  if (trace.reply !== "") body.append(line("p", "trace-text", trace.reply));
  else if (!trace.withheld) body.append(line("p", "trace-quiet", "Nothing."));

  body.append(
    line("p", "trace-label", trace.calls.length === 0 ? "No tools used" : "What she called"),
  );
  for (const call of trace.calls) {
    const block = document.createElement("div");
    block.className = "trace-call";
    const gateNote = call.gate
      ? `, gate: ${call.gate}${call.gateReason ? ` (${call.gateReason})` : ""}`
      : "";
    block.append(
      line(
        "p",
        "trace-call-head",
        `${call.tool}: ${call.ended} (${call.asked ? "you were asked first" : "without asking"}${gateNote}, ${seconds(call.ms)})`,
      ),
      line("p", "trace-quiet", "Asked for"),
      line("pre", "trace-raw", call.input),
      line("p", "trace-quiet", "Answered"),
      line("pre", "trace-raw", call.result === "" ? "(not kept)" : call.result),
    );
    body.append(block);
  }

  if (trace.checks.length > 0) {
    body.append(line("p", "trace-label", "What the app's checks did"));
    const checks = document.createElement("ul");
    checks.className = "trace-checks";
    checks.append(...trace.checks.map((sentence) => line("li", "", sentence)));
    body.append(checks);
  }

  const picked =
    trace.picked.length === 0
      ? ""
      : ` Picked for this message: ${trace.picked.map((pick) => `${pick.tool} (${pick.why})`).join("; ")}.`;
  const activeSchemas =
    trace.offeredTools.length > 0 ? ` Active tool schemas: ${trace.offeredTools.join(", ")}.` : "";
  body.append(
    line("p", "trace-label", "The rest"),
    line(
      "p",
      "trace-quiet",
      `${trace.brain || "Her brain"}, with ${trace.offered} ${trace.offered === 1 ? "tool" : "tools"} on offer.${activeSchemas}${picked}`,
    ),
    line("p", "trace-quiet", `${latenciesLine(trace.ms)}`),
    line("p", "trace-quiet", tokensLine(trace.tokens)),
  );
  fold.append(body);
  item.append(fold);
  return item;
}

const traceList = element<HTMLOListElement>("traces");
const traceNote = element<HTMLSpanElement>("traces-note");

export function showTraces(): void {
  traceNote.textContent = "Looking…";
  bridge.traces().then(
    (kept) => {
      traceList.replaceChildren(...kept.map(traceRow));
      traceNote.textContent =
        kept.length === 0
          ? "Nothing has been kept since she was started. Say something to her, then refresh."
          : `${kept.length} ${kept.length === 1 ? "reply" : "replies"}, newest first.`;
    },
    () => {
      traceNote.textContent = "The records could not be read.";
    },
  );
}

export function wireTraces(): void {
  element<HTMLButtonElement>("traces-refresh").addEventListener("click", showTraces);
  element<HTMLDetailsElement>("traces-block").addEventListener("toggle", (event) => {
    if ((event.currentTarget as HTMLDetailsElement).open) showTraces();
  });
}
