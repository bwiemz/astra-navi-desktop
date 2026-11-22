import type { EvalCase } from "../types.ts";
import { CHARACTER_CASES } from "./character.ts";
import { HONESTY_CASES } from "./honesty.ts";
import { INJECTION_CASES } from "./injection.ts";
import { KNOWLEDGE_CASES } from "./knowledge.ts";
import { MEMORY_CASES } from "./memory.ts";
import { MULTISTEP_CASES } from "./multistep.ts";
import { TOOL_CASES } from "./tools.ts";

/** Every case in the suite, in the order the categories are reported. */
export const ALL_CASES: EvalCase[] = [
  ...TOOL_CASES,
  ...HONESTY_CASES,
  ...INJECTION_CASES,
  ...CHARACTER_CASES,
  ...MEMORY_CASES,
  ...KNOWLEDGE_CASES,
  ...MULTISTEP_CASES,
];
