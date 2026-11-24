/**
 * Optional Local Vault & Codebase RAG Plugin (`defaultEnabled: false`).
 *
 * Exposes read-only hybrid semantic + lexical search across explicitly approved local
 * folders / Obsidian vaults / code repositories while rejecting sensitive paths
 * (`.ssh`, `.gnupg`, `.env`, private keys) and symlink escapes.
 */
import { VaultRagIndex } from "../../src/core/vaultRag.ts";
import type { Embedder } from "../../src/core/embedder.ts";
import type { PolicyContext } from "../../src/core/permissions.ts";

export interface LocalVaultPluginDeps {
  approvedRoots: readonly string[];
  policyContext?: PolicyContext;
  embedder?: Embedder | null;
}

export function createLocalVaultRagPlugin(deps: LocalVaultPluginDeps) {
  const index = new VaultRagIndex({
    approvedRoots: deps.approvedRoots,
    policyContext: deps.policyContext,
    embedder: deps.embedder,
  });

  return {
    id: "local-vault-rag",
    index,
    async handleTool(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const bareName = toolName.replace(/^plugin:/, "");
      switch (bareName) {
        case "vault.index_status": {
          return { ...index.status(), outsideText: true };
        }
        case "vault.reindex": {
          const stats = await index.reindex();
          return { ...stats, outsideText: true };
        }
        case "vault.search": {
          const query = typeof args["query"] === "string" ? args["query"].trim() : "";
          const limit = typeof args["limit"] === "number" ? args["limit"] : 5;
          const targetPath = typeof args["path"] === "string" ? args["path"].trim() : "";
          if (targetPath) {
            const pathCheck = index.isAllowedPath(targetPath);
            if (!pathCheck.ok) {
              throw new Error(pathCheck.reason);
            }
          }
          if (!query) {
            throw new Error("vault.search requires a non-empty `query` string.");
          }
          if (index.status().chunks === 0) {
            await index.reindex();
          }
          const hits = await index.search(query, limit);
          return {
            query,
            hits,
            outsideText: true,
          };
        }
        default:
          throw new Error(`Unknown plugin tool "${toolName}".`);
      }
    },
  };
}
