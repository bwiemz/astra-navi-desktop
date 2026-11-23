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

export function pickCohostReaction(event: CohostStreamEvent): CohostReaction {
  const who = (event.sender ?? "viewer").slice(0, 40).replace(/[\r\n]/g, " ");
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
          return { ...status, outsideText: true };
        }
        case "obs.switch_scene": {
          const scene = typeof args["scene"] === "string" ? args["scene"].trim() : "";
          if (!scene || scene.length > 80) {
            throw new Error("OBS scene name must be a non-empty string under 80 chars.");
          }
          const res = await deps.switchScene(scene);
          return { ok: res.ok, scene: res.scene };
        }
        case "obs.highlight_chat": {
          const reaction = pickCohostReaction({
            type: "chat_question",
            sender: typeof args["sender"] === "string" ? args["sender"] : undefined,
            text: typeof args["text"] === "string" ? args["text"] : undefined,
          });
          return { ...reaction, outsideText: true };
        }
        default:
          throw new Error(`Unsupported OBS co-host tool "${toolName}".`);
      }
    },
  };
}
