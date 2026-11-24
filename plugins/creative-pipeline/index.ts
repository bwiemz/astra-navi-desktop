import { resolve } from "node:path";
import { isInside, isSensitivePath } from "../../src/core/riskRules.ts";

/**
 * Optional Creative Pipeline Plugin (`defaultEnabled: false`).
 *
 * Tracks Blender / ComfyUI / FFmpeg render progress and validates output paths inside
 * explicitly approved render workspaces while rejecting sensitive system/credential paths.
 */

export interface RenderJobStatus {
  jobId: string;
  tool: "blender" | "comfyui" | "ffmpeg";
  currentFrame: number;
  totalFrames: number;
  outputDir: string;
  state: "queued" | "rendering" | "done";
}

export interface CreativePipelineDeps {
  approvedRenderRoots: readonly string[];
}

export function createCreativePipelinePlugin(deps: CreativePipelineDeps) {
  const jobs = new Map<string, RenderJobStatus>();

  function validateOutputDir(dirPath: string): { ok: true; resolved: string } | { ok: false; reason: string } {
    const clean = dirPath.trim();
    if (!clean) return { ok: false, reason: "Empty output directory." };
    const abs = resolve(clean);
    if (isSensitivePath(abs)) {
      return { ok: false, reason: `Refused sensitive output path "${clean}".` };
    }
    const allowed = deps.approvedRenderRoots.some((root) => isInside(abs, resolve(root)));
    if (!allowed) {
      return { ok: false, reason: `Render output "${clean}" lies outside approved render roots.` };
    }
    return { ok: true, resolved: abs };
  }

  return {
    id: "creative-pipeline",
    async handleTool(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const bare = toolName.replace(/^plugin:/, "");
      switch (bare) {
        case "creative.validate_output_path": {
          const path = typeof args["outputDir"] === "string" ? args["outputDir"] : "";
          return validateOutputDir(path);
        }
        case "creative.render_progress": {
          const jobId = typeof args["jobId"] === "string" ? args["jobId"].trim() : "";
          if (!jobId) {
            return { jobs: [...jobs.values()], outsideText: true };
          }
          const job = jobs.get(jobId) ?? null;
          return { job, outsideText: true };
        }
        case "creative.queue_render": {
          const jobId = typeof args["jobId"] === "string" ? args["jobId"].trim() : `job-${Date.now()}`;
          const toolRaw = typeof args["tool"] === "string" ? args["tool"].trim() : "blender";
          const tool: RenderJobStatus["tool"] =
            toolRaw === "comfyui" || toolRaw === "ffmpeg" ? toolRaw : "blender";
          const outputDirRaw = typeof args["outputDir"] === "string" ? args["outputDir"] : "";
          const check = validateOutputDir(outputDirRaw);
          if (!check.ok) {
            throw new Error(check.reason);
          }
          const totalFrames = Math.max(
            1,
            Math.round(typeof args["totalFrames"] === "number" ? args["totalFrames"] : 240),
          );
          const status: RenderJobStatus = {
            jobId,
            tool,
            currentFrame: 0,
            totalFrames,
            outputDir: check.resolved,
            state: "queued",
          };
          jobs.set(jobId, status);
          return { ok: true, job: status };
        }
        default:
          throw new Error(`Unknown plugin tool "${toolName}".`);
      }
    },
  };
}
