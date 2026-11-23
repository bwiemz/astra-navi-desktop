/**
 * Optional OBS & Twitch Co-Host Creator Plugin Pack (defaultEnabled: false).
 *
 * Exposes read-only stream status and chat highlight formatters plus an approval-gated
 * scene switch action backed by local OBS WebSocket/MCP and Astra's expanded gestures.
 */

export interface ObsStatusSnapshot {
  streaming: boolean;
  recording: boolean;
  currentScene: string;
  viewerCount?: number;
}

export interface CohostStreamEvent {
  type: "raid" | "follow" | "cheer" | "chat_question" | "brb";
  sender?: string;
  text?: string;
}

export interface CohostReaction {
  mood: "happy" | "excited" | "thinking" | "surprised" | "neutral";
  gesture: "cheer" | "wave" | "salute" | "nod" | "perk";
  callout: string;
}

export interface ObsCohostDeps {
  fetchStatus(): Promise<ObsStatusSnapshot>;
  switchScene(sceneName: string): Promise<{ ok: boolean; scene: string }>;
}

function sanitizeObsText(raw: string, maxLen: number): string {
  let clean = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      clean += " ";
    } else {
      clean += raw[i] ?? "";
    }
  }
  return clean.replaceAll("[[", "[").replaceAll("]]", "]").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function hasControlChars(raw: string): boolean {
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return raw.includes("[[") || raw.includes("]]");
}

export function pickCohostReaction(event: CohostStreamEvent): CohostReaction {
  const who = sanitizeObsText(event.sender ?? "viewer", 40) || "viewer";
  switch (event.type) {
    case "raid":
      return {
        mood: "excited",
        gesture: "cheer",
        callout: `Welcome raiders with ${who}! Raising stage energy.`,
      };
    case "follow":
      return {
        mood: "happy",
        gesture: "wave",
        callout: `Thanks for the follow, ${who}!`,
      };
    case "cheer":
      return {
        mood: "excited",
        gesture: "salute",
        callout: `Cheers from ${who}!`,
      };
    case "chat_question":
      return {
        mood: "thinking",
        gesture: "nod",
        callout: `Highlighting question from ${who}.`,
      };
    case "brb":
      return {
        mood: "neutral",
        gesture: "perk",
        callout: "Stream intermission standing by.",
      };
  }
}

export function createObsCohostPlugin(deps: ObsCohostDeps) {
  return {
    id: "obs-cohost",
    async handleTool(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const bareName = toolName.replace(/^plugin:/, "");
      switch (bareName) {
        case "obs.get_status": {
          const status = await deps.fetchStatus();
          return {
            ...status,
            currentScene: sanitizeObsText(status.currentScene, 80),
            outsideText: true,
          };
        }
        case "obs.switch_scene": {
          const rawScene = typeof args["scene"] === "string" ? args["scene"].trim() : "";
          if (!rawScene || rawScene.length > 80 || hasControlChars(rawScene)) {
            throw new Error("OBS scene name must be a clean non-empty string under 80 chars.");
          }
          const res = await deps.switchScene(rawScene);
          return { ok: res.ok, scene: sanitizeObsText(res.scene, 80) };
        }
        case "obs.highlight_chat": {
          const reaction = pickCohostReaction({
            type: "chat_question",
            sender: typeof args["sender"] === "string" ? args["sender"] : undefined,
            text:
              typeof args["text"] === "string" ? sanitizeObsText(args["text"], 200) : undefined,
          });
          return { ...reaction, outsideText: true };
        }
        default:
          throw new Error(`Unsupported OBS co-host tool "${toolName}".`);
      }
    },
  };
}
