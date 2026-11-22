import { appendFile, chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { TurnTrace } from "./trace.ts";

/**
 * The records of her replies, kept on disk when the user has asked for that: one JSON
 * object to a line, in a file only they can read. Written one after another in the
 * order the replies happened. A record that cannot be written is let go with one
 * warning; keeping records must never be what spoils a reply.
 */
export class TraceFile {
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(file: string) {
    this.file = file;
  }

  /** Adds a record to the end of the file. Returns at once. */
  append(trace: TurnTrace): void {
    const line = `${JSON.stringify(trace)}\n`;
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await appendFile(this.file, line, { encoding: "utf8", mode: 0o600 });
        // The mode above only counts when the file is new; one made earlier is put right.
        await chmod(this.file, 0o600);
      } catch (error) {
        if (!this.warned) {
          this.warned = true;
          console.warn("[trace] the record of a reply could not be written down:", error);
        }
      }
    });
  }

  /** Deletes the file, once anything still being written to it has been. */
  clear(): Promise<void> {
    this.writing = this.writing.then(() => rm(this.file, { force: true })).catch(() => undefined);
    return this.writing;
  }

  /** Resolves when everything handed over so far has been written. */
  whenWritten(): Promise<void> {
    return this.writing;
  }
}
