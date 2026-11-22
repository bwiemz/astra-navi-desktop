/**
 * Blanks out things that look like credentials before anything is kept: a command line
 * can carry a token, and a note is replayed into future conversations and sits in a file.
 */
export function withoutSecrets(text: string): string {
  return (
    text
      .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [hidden]")
      .replace(
        /\b((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|auth)[\w-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
        "$1[hidden]",
      )
      // As written in a tool call's arguments: {"password":"…"}, {"api_key": "…"}.
      .replace(
        /("(?:[\w-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|auth)[\w-]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
        '$1"[hidden]"',
      )
      .replace(/(--?(?:password|passwd|token|secret|api-key|key)[= ])(\S+)/gi, "$1[hidden]")
      .replace(/(:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1[hidden]@")
      .replace(/\b(?:sk|pk|ghp|gho|github_pat|xox[abp]|hf)[-_][A-Za-z0-9_-]{16,}\b/g, "[hidden]")
      .replace(/\b[A-Fa-f0-9]{40,}\b/g, "[hidden]")
  );
}
