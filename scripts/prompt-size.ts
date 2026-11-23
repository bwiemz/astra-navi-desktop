/**
 * How much of her working memory her instructions and tools take before a word is said.
 *
 *   npm run prompt-size
 *   npm run prompt-size -- --ci
 *
 * Uses the small brain's tokenizer locally when available, or falls back to an offline
 * estimator in `--ci` / model-free environments so CI always enforces prompt budgets.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLlama, QwenChatWrapper, type ChatSessionModelFunctions } from "node-llama-cpp";
import { createTools, type ToolHost } from "../src/core/agentTools.ts";
import { createDesktopTools } from "../src/core/desktopTools.ts";
import { detectEnvironment } from "../src/core/environment.ts";
import { createFleetTools } from "../src/core/fleetTools.ts";
import { createHandsTools } from "../src/core/handsTools.ts";
import { createKnowledgeTools } from "../src/core/knowledgeTools.ts";
import { BRAIN_MODELS } from "../src/core/models.ts";
import { createNoticeTools } from "../src/core/noticeTools.ts";
import { modelsDir, workspaceDir } from "../src/core/paths.ts";
import { buildSystemPrompt, EVERY_ABILITY, type Abilities } from "../src/core/persona.ts";
import { createPhoneTools } from "../src/core/phoneTools.ts";
import { createShipTools } from "../src/core/shipTools.ts";
import { CORE_TOOLS } from "../src/core/toolRouter.ts";

const ciMode = process.argv.includes("--ci");
const modelPath = join(modelsDir(), BRAIN_MODELS.small.fileName);
const useRealVocab = !ciMode && existsSync(modelPath);

const llama = useRealVocab ? await getLlama({ gpu: false }) : null;
const model = llama
  ? await llama.loadModel({ modelPath, vocabOnly: true })
  : null;
const approxTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 3.7);
const count = (text: string): number =>
  model ? model.tokenize(text, true).length : approxTokens(text);

// The tools are only described here, never called, so what they would work with is left empty.
const nothing = {} as never;
const host = { policy: () => ({ workspace: "/tmp" }) } as unknown as ToolHost;
const groups: Record<string, ChatSessionModelFunctions> = {
  "files, web, memory, apps": createTools(host),
  "sums, weather, finding files": createKnowledgeTools(host),
  "screen, sound, windows": createDesktopTools(host, {
    sight: nothing,
    scriptDir: "/tmp",
    ears: () => nothing,
  }),
  "the ship (reminders, jobs, watches, agenda)": createShipTools(host, {
    reminders: nothing,
    missions: nothing,
    deckLogFile: "/tmp/deck-log.md",
    research: nothing,
    selfCheck: nothing,
    orders: nothing,
    agenda: nothing,
  }),
  "inside other programs (optional)": createHandsTools(host, {
    hands: nothing,
    scriptDir: "/tmp",
    ownApps: [],
  }),
  "phone (optional)": createPhoneTools(host),
  "other machines (optional)": createFleetTools(host, nothing),
  "notifications (optional)": createNoticeTools(host, () => null),
};

const environment = await detectEnvironment(workspaceDir());
const none = Object.fromEntries(
  Object.keys(EVERY_ABILITY).map((key) => [key, false]),
) as unknown as Abilities;
const notes = "- [ab12] (profile) Captain's name is Sam.\n- [cd34] (project) A game in Unreal.";
const instructions = (has: Abilities): string =>
  buildSystemPrompt(environment, notes, "en", 30, has);

const wrapper = new QwenChatWrapper();
const opening = (system: string, functions?: ChatSessionModelFunctions): number => {
  const rendered = wrapper.generateContextState({
    chatHistory: [
      { type: "system", text: system },
      { type: "user", text: "hello" },
      { type: "model", response: [] },
    ],
    availableFunctions: functions,
    documentFunctionParams: true,
  }).contextText;
  return model ? rendered.tokenize(model.tokenizer).length : approxTokens(rendered.toString());
};

const full = instructions(EVERY_ABILITY);
const bare = instructions(none);
const everyTool = Object.assign({}, ...Object.values(groups)) as ChatSessionModelFunctions;
const coreOnly = Object.fromEntries(
  Object.entries(everyTool).filter(([name]) => (CORE_TOOLS as readonly string[]).includes(name)),
) as ChatSessionModelFunctions;
const usual = Object.assign(
  {},
  ...Object.entries(groups)
    .filter(([name]) => !name.includes("optional"))
    .map(([, tools]) => tools),
) as ChatSessionModelFunctions;
const empty = opening(full);
// Offering any tool at all costs a fixed passage on how to call one: what two tools
// cost apart, less what they cost together.
const [first, second] = Object.entries(everyTool);
const alone = (entry: [string, ChatSessionModelFunctions[string]]): number =>
  opening(full, { [entry[0]]: entry[1] }) - empty;
const fixed =
  first && second
    ? alone(first) +
      alone(second) -
      (opening(full, { [first[0]]: first[1], [second[0]]: second[1] }) - empty)
    : 0;

const bareTokens = count(bare);
const fullTokens = opening(full, everyTool);
const coreRoutedTokens = opening(bare, coreOnly);

const lines: string[] = [
  `Tokenizer mode: ${model ? "Qwen3.5-4B GGUF vocab" : "offline byte-BPE estimate (--ci / missing model)"}`,
  `Her instructions: ${bareTokens} tokens with no optional ability switched on, ${count(full)} with all of them.`,
  `Dynamic core baseline (${Object.keys(coreOnly).length} routed core tools): ${coreRoutedTokens} tokens.`,
  `With her usual tools (${Object.keys(usual).length}): ${opening(bare, usual)} tokens before the first message.`,
  `With everything switched on (${Object.keys(everyTool).length} tools): ${fullTokens} tokens.`,
  "",
  "By group:",
  ...Object.entries(groups).map(
    ([name, tools]) =>
      `  ${String(opening(full, tools) - empty).padStart(5)}  ${name} (${Object.keys(tools).length})`,
  ),
  "",
  `By tool (offering any tool at all costs ${fixed}; that is taken off each figure):`,
  ...Object.entries(everyTool)
    .map(([name, tool]) => [name, opening(full, { [name]: tool }) - empty - fixed] as const)
    .sort((a, b) => b[1] - a[1])
    .map(([name, tokens]) => `  ${String(tokens).padStart(5)}  ${name}`),
];
console.log(lines.join("\n"));
await model?.dispose();
await llama?.dispose();

if (ciMode && (bareTokens > 4500 || coreRoutedTokens > 5500 || fullTokens > 12000)) {
  console.error(
    `Prompt budget exceeded: bare=${bareTokens}, coreRouted=${coreRoutedTokens}, full=${fullTokens}.`,
  );
  process.exit(1);
}
