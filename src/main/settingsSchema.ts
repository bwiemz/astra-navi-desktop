import { isAbsolute } from "node:path";
import { z } from "zod";
import { LANGUAGE_CODES } from "../core/languages.ts";
import { BRAIN_MODELS, findCatalogEntry } from "../core/models.ts";

/**
 * What the settings page may send. The page is her own, but what arrives from it is
 * checked all the same before anything is changed: every field has a kind and a limit,
 * and a field nobody here knows is refused.
 */

/** A name and password for the station, as the settings page sends them. What they may be is checked by the account itself. */
export const StationAccountSchema = z.object({
  username: z.string().max(64),
  password: z.string().max(200),
});

export const SettingsPatchSchema = z
  .object({
    // "auto", a built-in tier, a rolling catalog preset, or a model file of the user's own.
    brain: z
      .string()
      .max(300)
      .refine(
        (value) =>
          value === "auto" ||
          Object.hasOwn(BRAIN_MODELS, value) ||
          findCatalogEntry(value) !== null ||
          (isAbsolute(value) && /\.gguf$/i.test(value)),
      ),
    language: z.enum(LANGUAGE_CODES),
    voice: z.object({ engine: z.enum(["full", "light"]), design: z.string().max(60) }),
    speed: z.number().min(0.5).max(2),
    speak: z.enum(["when-spoken-to", "always", "never"]),
    alwaysListening: z.boolean(),
    needsName: z.boolean(),
    otherNames: z.array(z.string().max(40)).max(5),
    lookWithoutAsking: z.boolean(),
    handsOff: z.boolean(),
    keepConversations: z.boolean(),
    doNotDisturb: z.boolean(),
    morningBriefing: z.boolean(),
    startAtLogin: z.boolean(),
    idleUnloadMinutes: z.number().min(0).max(1440),
    thinkingTokens: z.number().int().min(0).max(2048),
    yieldToGames: z.boolean(),
    quietInGames: z.boolean(),
    leanMemory: z.boolean(),
    fittingTools: z.boolean(),
    keepTraces: z.boolean(),
    searxngUrl: z.string().max(300),
    braveApiKey: z.string().max(200),
    braveMonthlyLimit: z.number().int().min(0).max(1_000_000),
    workInPrograms: z.boolean(),
    watch: z.boolean(),
    watchSkip: z.array(z.string().max(60)).max(30),
    hearPc: z.boolean(),
    readNotices: z.boolean(),
    noticesSkip: z.array(z.string().max(60)).max(30),
    headsUpMinutes: z.number().int().min(0).max(120),
    station: z.boolean(),
    pingPhone: z.boolean(),
    onboardingComplete: z.boolean(),
    advancedSettings: z.boolean(),
    windowMode: z.enum(["floating", "solid-docked"]),
    lowPowerStage: z.boolean(),
    hotkeys: z
      .object({
        pushToTalk: z.string().max(40),
        summonHide: z.string().max(40),
        clickThrough: z.string().max(40),
      })
      .partial()
      .strict(),
    tier10: z
      .object({
        workerMesh: z.boolean(),
        modelCascade: z.boolean(),
        loraSubAgents: z.boolean(),
        predictivePrewarm: z.boolean(),
        semanticBridges: z.boolean(),
        pushEvents: z.boolean(),
        hardwareTelemetry: z.boolean(),
        sessionContinuity: z.boolean(),
        causalDryRun: z.boolean(),
        skillCompiler: z.boolean(),
        microSandbox: z.boolean(),
        episodicCalibration: z.boolean(),
        attentionArbiter: z.boolean(),
        nightlyHygiene: z.boolean(),
        fullDuplexVoice: z.boolean(),
        phonemeVisemes: z.boolean(),
        selfDistillation: z.boolean(),
        signedPlugins: z.boolean(),
        nativeMultimodal: z.boolean(),
        householdIsolation: z.boolean(),
        stationFederation: z.boolean(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
