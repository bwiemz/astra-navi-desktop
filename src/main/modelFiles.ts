import { rm } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { dialog, net, protocol } from "electron";
import {
  openSignedCharacterBundle,
  type CharacterBundleManifest,
} from "../core/characterBundle.ts";
import {
  openLooseModelFolder,
  openModelBundle,
  packModel,
  type ModelBundle,
} from "../core/modelBundle.ts";
import { modelKeyMaterial } from "../core/modelKey.ts";
import { modelBundleFile, modelKeyFile } from "../core/paths.ts";
import { UNOFFICIAL_NOTICE, type AppState } from "../shared/ipc.ts";
import { oneAtATime } from "./once.ts";

/**
 * The character model's files: packing a model the user imports into one encrypted
 * file that only opens on this computer, opening it, and handing its parts to her own
 * window and to nothing else.
 *
 * This is where the rule that the raw model can never be taken out of the project is
 * kept: the packed file is read with a key made for this computer and this account, its
 * parts are served only at the app's own address, to the app's own page, and are never
 * written anywhere as files.
 */

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".tga": "image/x-tga",
  ".dds": "image/vnd-ms.dds",
};

export interface ModelFilesDeps {
  /** The app's own address scheme, and the origin of her page under it. */
  scheme: string;
  appOrigin: string;
  /** Where the built page is. */
  rendererDir: string;
  sendToWindow(channel: string, payload?: unknown): void;
  appState(showNotice: boolean): AppState;
  /** Optional distributable loose .pmx fallback when no user-imported model bundle exists yet. */
  defaultModelPath?: string;
}

export interface ModelFiles {
  /** The model that is open now, or null when none has been imported. */
  bundle(): ModelBundle | null;
  /** Goes up each time the model is opened afresh, so a new one is not served from a cache. */
  revision(): number;
  loadModelBundle(): Promise<void>;
  switchCharacterBundle(
    bundlePath: string,
    options?: { trustedPublicKeysPem?: readonly string[]; requireSignature?: boolean },
  ): Promise<CharacterBundleManifest>;
  packIntoBundle(file: string): Promise<number>;
  registerProtocol(): void;
  importModel(): Promise<void>;
  removeModel(): Promise<void>;
}

export function createModelFiles(deps: ModelFilesDeps): ModelFiles {
  let modelBundle: ModelBundle | null = null;
  let modelRevision = 0;

  async function loadModelBundle(): Promise<void> {
    modelBundle = null;
    modelRevision += 1;
    try {
      const key = await modelKeyMaterial(modelKeyFile(), false);
      // No key means nothing was ever imported with this version; fall back to the bundled default if present.
      if (key) modelBundle = await openModelBundle(modelBundleFile(), key);
      if (!modelBundle && deps.defaultModelPath) {
        modelBundle = await openLooseModelFolder(deps.defaultModelPath);
      }
    } catch (error) {
      console.error("[model]", error);
      dialog.showErrorBox(
        "Character model",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function packIntoBundle(file: string): Promise<number> {
    const key = await modelKeyMaterial(modelKeyFile(), true);
    if (!key) throw new Error("Could not create this computer's key for the model.");
    const { files } = await packModel(file, modelBundleFile(), key);
    return files;
  }

  function serveModelFile(url: URL): Response {
    // Path looks like /<revision>/<path inside the bundle>.
    const path = decodeURIComponent(url.pathname).split("/").slice(2).join("/");
    const data = modelBundle?.get(path);
    if (!data) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        "access-control-allow-origin": deps.appOrigin,
        "cache-control": "no-store",
      },
    });
  }

  function serveAppFile(url: URL): Promise<Response> | Response {
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = normalize(join(deps.rendererDir, relative));
    if (!file.startsWith(deps.rendererDir + sep)) return new Response(null, { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  }

  function registerProtocol(): void {
    protocol.handle(deps.scheme, (request) => {
      const url = new URL(request.url);
      if (url.host === "model") return serveModelFile(url);
      if (url.host === "app") return serveAppFile(url);
      return new Response(null, { status: 404 });
    });
  }

  /** One import at a time: a second request while its dialogs are open is not a second import. */
  const importModel = oneAtATime(chooseAndImportModel, (error) =>
    console.error("[model] import failed:", error),
  );

  async function chooseAndImportModel(): Promise<void> {
    const consent = await dialog.showMessageBox({
      type: "info",
      title: "Import a character model",
      message: "Choose the model's .pmx file",
      detail:
        "Use a model you are permitted to use, such as an official fan-use release, and follow its terms.\n\n" +
        "The model and its textures are packed into one encrypted file that only opens on this computer, " +
        "for this user account. The app never shares, uploads or exposes the raw model files.\n\n" +
        UNOFFICIAL_NOTICE,
      buttons: ["Choose file…", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (consent.response !== 0) return;

    const picked = await dialog.showOpenDialog({
      title: "Choose the model's .pmx file",
      properties: ["openFile"],
      filters: [{ name: "MMD model", extensions: ["pmx", "pmd"] }],
    });
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return;

    try {
      const files = await packIntoBundle(file);
      await loadModelBundle();
      deps.sendToWindow("app:state", deps.appState(false));
      console.log(`[model] imported ${files} files`);
    } catch (error) {
      dialog.showErrorBox(
        "Could not import the model",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function removeModel(): Promise<void> {
    const answer = await dialog.showMessageBox({
      type: "question",
      message: "Remove the imported character model?",
      detail: "The packed copy is deleted from this computer. Your original files are not touched.",
      buttons: ["Remove", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (answer.response !== 0) return;
    await rm(modelBundleFile(), { force: true });
    await loadModelBundle();
    deps.sendToWindow("app:state", deps.appState(false));
  }

  async function switchCharacterBundle(
    bundlePath: string,
    options: { trustedPublicKeysPem?: readonly string[]; requireSignature?: boolean } = {},
  ): Promise<CharacterBundleManifest> {
    const opened = await openSignedCharacterBundle(bundlePath, options);
    modelBundle = opened.bundle;
    modelRevision += 1;
    deps.sendToWindow("app:state", deps.appState(false));
    return opened.manifest;
  }

  return {
    bundle: () => modelBundle,
    revision: () => modelRevision,
    loadModelBundle,
    switchCharacterBundle,
    packIntoBundle,
    registerProtocol,
    importModel,
    removeModel,
  };
}
