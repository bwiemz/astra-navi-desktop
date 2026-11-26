import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { isReservedCalendarName, MAX_CALENDARS, whyNotThisCalendar } from "./agenda.ts";
import { MACHINE_HOST, MACHINE_NAME, MACHINE_USER } from "./fleet.ts";
import { LANGUAGE_CODES } from "./languages.ts";
import { MAX_MCP_SERVERS, McpServerConfigSchema } from "./mcpClient.ts";

const CalendarSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    // Counted in characters as a person counts them, the way a name is cut when it is taken.
    .refine((name) => Array.from(name).length <= 40)
    // Her own list's name is hers alone.
    .refine((name) => !isReservedCalendarName(name)),
  source: z
    .string()
    .max(500)
    .refine((source) => whyNotThisCalendar(source) === null),
});

const ConfigSchema = z.object({
  /**
   * Which language model she thinks with: "auto" (picked for this computer), "small",
   * "standard", "large", "xl", or the full path of any GGUF model file.
   */
  brain: z.string().default("auto"),
  /** How much conversation she can hold in mind at once, in tokens. More uses more memory. */
  contextSize: z.number().int().min(4096).max(131072).default(16384),
  /** How long she may think to herself before answering, in tokens. 0 answers at once. */
  thinkingTokens: z.number().int().min(0).max(4096).default(256),
  /** Free the model's memory after this many minutes without a message. 0 keeps it loaded. */
  idleUnloadMinutes: z.number().min(0).max(1440).default(10),
  /**
   * While a game is running, give the graphics card's memory back a minute after each
   * reply instead of after the usual wait; and with the brain on "auto", take the small
   * brain when the standard one no longer fits beside what is on the card.
   */
  yieldToGames: z.boolean().default(true),
  /**
   * While a game is running, hold back what she would bring up by herself and tell it
   * as one thing when the game ends; and show reminders and the like at once as plain
   * notices, without waking her and loading her model onto the card the game is using.
   */
  quietInGames: z.boolean().default(true),
  /**
   * Hold the conversation in less graphics memory. Only for the built-in brains: the
   * setting has not been tried with other model files, and is ignored for them.
   */
  leanMemory: z.boolean().default(false),
  /**
   * Offer her, for each message, a core of everyday tools and the ones the message looks
   * to be about, in place of every tool every time: about 3,000 tokens less to hold in
   * mind. Off until asked for. Measured on the small brain: neither better nor worse at
   * choosing, with a router that always guessed right (see `toolRouter.ts`).
   */
  fittingTools: z.boolean().default(false),
  /**
   * Write the record of each reply (what was asked, the tools on offer, each call and its
   * answer, what she said, which checks stepped in) to a file in her data folder. The
   * last few are always kept in memory for the page that shows them; this keeps them
   * across restarts, for `npm run export-pairs`. Off until asked for: the file is as
   * private as the conversation itself.
   */
  keepTraces: z.boolean().default(false),
  /** The language she speaks and listens in. */
  language: z.enum(LANGUAGE_CODES).default("en"),
  voice: z
    .object({
      /**
       * "full": the designed voice (every language; needs a graphics card and a one-time
       * set-up). "light": a small built-in voice (English only; runs anywhere).
       * "auto": full when it has been set up, light otherwise.
       */
      engine: z.enum(["auto", "full", "light"]).default("auto"),
      /** Which designed voice the full engine uses: a file name in assets/voice, without ".wav". */
      design: z.string().default("perky"),
      /** Which built-in voice the light engine uses. */
      name: z.string().default("af_heart"),
      speed: z.number().min(0.5).max(2).default(1.05),
      /**
       * Keep the microphone on from the moment she starts, and wake when her name is said,
       * the way a smart speaker does. Speech that does not start with her name is ignored.
       */
      alwaysListening: z.boolean().default(false),
      /**
       * Other names she answers to besides "AI-chan", for example "Computer". Worth
       * setting when speech recognition keeps mishearing her name in your voice.
       */
      otherNames: z.array(z.string().max(40)).max(5).default([]),
      /** With the microphone on, only answer speech that starts with her name. */
      needsName: z.boolean().default(false),
      /** When she speaks her replies: only when you spoke to her, always, or never. */
      speak: z.enum(["when-spoken-to", "always", "never"]).default("when-spoken-to"),
    })
    .prefault({}),
  /** Her hands are off the controls: she can look things up and talk, and change nothing. */
  handsOff: z.boolean().default(false),
  /** When the app was first started: the day the two of them met. */
  firstMetAt: z.string().nullable().default(null),
  /** Keep past conversations on this computer so she can look back at what was said. */
  keepConversations: z.boolean().default(true),
  sight: z
    .object({
      /** She may look at the screen whenever it helps, without asking each time. */
      withoutAsking: z.boolean().default(false),
      /**
       * She keeps an eye on the screen all the time: which program is in front and what
       * it shows. Nothing she sees this way is written to disk.
       */
      watch: z.boolean().default(false),
      /** Programs she never reads while watching, besides the built-in list (password managers and the like). */
      watchSkip: z.array(z.string().max(60)).max(30).default([]),
    })
    .prefault({}),
  hands: z
    .object({
      /**
       * She may work inside other programs: press their buttons and menus, fill in their
       * fields, click and type. Each program is still asked about before she starts.
       */
      inPrograms: z.boolean().default(false),
    })
    .prefault({}),
  fleet: z
    .object({
      /** The user's other machines she may reach over SSH, each added and let in by the user. */
      machines: z
        .array(
          z.object({
            id: z.string().regex(/^[a-f0-9]{8,40}$/),
            // The same checks as when one is added, so a hand-edited file cannot slip an
            // option or an address in another form past them.
            name: z.string().regex(MACHINE_NAME),
            host: z.string().max(253).regex(MACHINE_HOST),
            port: z.number().int().min(1).max(65535).default(22),
            user: z.string().regex(MACHINE_USER),
            /** She may run the plain status commands there without asking each time. */
            lookWithoutAsking: z.boolean().default(false),
            /** Explicit user opt-in allowing sensitive context when offloading to this host. */
            fullMirrorTrusted: z.boolean().optional(),
          }),
        )
        .max(24)
        .default([]),
    })
    .prefault({}),
  hearing: z
    .object({
      /**
       * She keeps the last minute and a half of what the PC played in memory, so she can
       * be asked what was just said. Never written to disk.
       */
      pcAudio: z.boolean().default(false),
    })
    .prefault({}),
  notices: z
    .object({
      /**
       * She may read the desktop's notifications, so she can be asked what one said.
       * They carry other people's words, so this is off until the user switches it on.
       * What she reads is kept in memory only, never written to disk.
       */
      read: z.boolean().default(false),
      /** Programs whose notifications she never reads, besides the built-in list (password managers and the like). */
      skip: z.array(z.string().max(60)).max(30).default([]),
    })
    .prefault({}),
  agenda: z
    .object({
      /**
       * The user's calendars, which she reads and never changes: each a file on this PC
       * or the private address of a calendar feed. Only the user adds these, in Settings.
       */
      // One entry that will not do (edited by hand, or written under an older rule) is
      // left out by itself. It must not cost the user every other setting in the file.
      calendars: z
        .preprocess(
          (given) =>
            Array.isArray(given)
              ? given
                  .flatMap((entry) => {
                    const taken = CalendarSchema.safeParse(entry);
                    return taken.success ? [taken.data] : [];
                  })
                  .slice(0, MAX_CALENDARS)
              : [],
          z.array(CalendarSchema).max(MAX_CALENDARS),
        )
        .default([]),
      /** She says so this many minutes before something on the agenda starts. 0: never. */
      headsUpMinutes: z.number().int().min(0).max(120).default(15),
    })
    .prefault({}),
  devices: z
    .object({
      /** Other devices on the home network may talk to her through a page she serves. */
      station: z.boolean().default(false),
      stationPort: z.number().int().min(1024).max(65535).default(47821),
      /** Reminders are also sent to the paired phone (KDE Connect) when one is in reach. */
      pingPhone: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Optional: a search engine of the user's own. Without either she still looks things up
   * in open sources (Wikipedia and others) and, failing that, in her own browser.
   */
  search: z
    .object({
      /** Base address of a SearXNG the user runs, for example "http://localhost:8888". */
      searxngUrl: z.string().nullable().default(null),
      /** A Brave Search API key the user obtained themselves. */
      braveApiKey: z.string().nullable().default(null),
      /** The most searches she may send to Brave in one calendar month. 0 means no limit. */
      braveMonthlyLimit: z.number().int().min(0).max(1_000_000).default(1000),
    })
    .prefault({}),
  /** While on, she only speaks first about things you asked for (reminders, jobs you started). */
  doNotDisturb: z.boolean().default(false),
  /** A short status briefing the first time she is started each day. */
  morningBriefing: z.boolean().default(true),
  /** When each kind of problem was last raised, so a restart does not announce it again. */
  alertsRaised: z.record(z.string(), z.number()).default({}),
  /** The day (YYYY-MM-DD) the last briefing was given. */
  lastBriefingDay: z.string().nullable().default(null),
  /** Whether the user has completed the initial 60-second setup wizard. */
  onboardingComplete: z.boolean().default(false),
  /** Whether power-user controls and diagnostics are expanded in Settings. */
  advancedSettings: z.boolean().default(false),
  /** Whether the startup/model notice has been shown at least once. */
  noticeShown: z.boolean().default(false),
  /** Optional selected custom character bundle directory name or path. */
  characterBundle: z.string().max(300).nullable().default(null),
  /** Desktop presentation mode: transparent always-on-top overlay or solid opaque docked window. */
  windowMode: z.enum(["floating", "solid-docked"]).default("floating"),
  /** Caps 3D stage FPS and resolution scaling for battery-conscious laptops. */
  lowPowerStage: z.boolean().default(false),
  /** Per-model camera zoom/offset and lighting/outline framing keyed by model hash. */
  avatarFraming: z
    .record(
      z.string().regex(/^[a-f0-9]{8,64}$/),
      z
        .object({
          scale: z.number().min(0.45).max(2.2).default(1),
          offsetX: z.number().min(-0.6).max(0.6).default(0),
          offsetY: z.number().min(-0.6).max(0.6).default(0),
          rimLight: z.number().min(0.4).max(1.8).default(1),
          outlineThickness: z.number().min(0).max(2.5).default(1),
        })
        .prefault({}),
    )
    .default({}),
  /** Optional global desktop shortcuts (Electron Accelerator format, empty = unbound). */
  hotkeys: z
    .object({
      pushToTalk: z.string().max(40).default(""),
      summonHide: z.string().max(40).default(""),
      clickThrough: z.string().max(40).default(""),
    })
    .prefault({}),
  /** External MCP servers configured explicitly by the user in Settings (never added by the model). */
  mcp: z
    .object({
      servers: z
        .preprocess(
          (given) =>
            Array.isArray(given)
              ? given
                  .flatMap((entry) => {
                    const taken = McpServerConfigSchema.safeParse(entry);
                    return taken.success ? [taken.data] : [];
                  })
                  .slice(0, MAX_MCP_SERVERS)
              : [],
          z.array(McpServerConfigSchema).max(MAX_MCP_SERVERS),
        )
        .default([]),
    })
    .prefault({}),
  /** Tier 10 experimental capabilities: strictly default-off until opted in. */
  tier10: z
    .object({
      workerMesh: z.boolean().default(false),
      modelCascade: z.boolean().default(false),
      loraSubAgents: z.boolean().default(false),
      predictivePrewarm: z.boolean().default(false),
      semanticBridges: z.boolean().default(false),
      pushEvents: z.boolean().default(false),
      hardwareTelemetry: z.boolean().default(false),
      sessionContinuity: z.boolean().default(false),
      causalDryRun: z.boolean().default(false),
      skillCompiler: z.boolean().default(false),
      microSandbox: z.boolean().default(false),
      episodicCalibration: z.boolean().default(false),
      attentionArbiter: z.boolean().default(false),
      nightlyHygiene: z.boolean().default(false),
      fullDuplexVoice: z.boolean().default(false),
      phonemeVisemes: z.boolean().default(false),
      selfDistillation: z.boolean().default(false),
      signedPlugins: z.boolean().default(false),
      nativeMultimodal: z.boolean().default(false),
      householdIsolation: z.boolean().default(false),
      stationFederation: z.boolean().default(false),
    })
    .prefault({}),
  /** Wave 2 (`v1.2`) opt-in management settings: empty & disabled by default for v1.0/v1.1 parity. */
  wave2: z
    .object({
      vaultRoots: z.array(z.string().max(400)).max(16).default([]),
      lanPeers: z
        .array(
          z.object({
            id: z.string().regex(/^[a-zA-Z0-9._-]{2,64}$/),
            label: z.string().min(1).max(80),
            endpoint: z.string().max(240),
            publicKeyPem: z.string().max(2048),
            pairedAt: z.string(),
          }),
        )
        .max(24)
        .default([]),
      enabledPlugins: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/)).max(32).default([]),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigStore {
  private readonly file: string;
  private current: Config = ConfigSchema.parse({});
  private writeChain: Promise<void> = Promise.resolve();
  /** Called whenever a setting changes, so whatever shows the settings can be brought up to date. */
  onChange: (() => void) | null = null;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<Config> {
    try {
      const raw = await readFile(this.file, "utf8");
      // A file written by an older version may be readable by other accounts.
      await chmod(this.file, 0o600).catch(() => undefined);
      const parsed = ConfigSchema.safeParse(JSON.parse(raw));
      if (parsed.success) this.current = parsed.data;
      else console.warn(`[config] ignoring invalid config file: ${parsed.error.message}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[config] could not read ${this.file}:`, error);
      }
    }
    return this.current;
  }

  get value(): Config {
    return this.current;
  }

  update(patch: Partial<Config>): Promise<void> {
    this.current = { ...this.current, ...patch };
    this.onChange?.();
    const snapshot = JSON.stringify(this.current, null, 2);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        // It can hold a search key, so only the user may read it.
        await writeFile(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, this.file);
      });
    return this.writeChain;
  }
}
