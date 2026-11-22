import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname } from "node:path";

/**
 * Builds the secret the model bundle's key is derived from. Three things go into it:
 *
 * 1. A random secret created on this computer the first time a model is imported and
 *    kept in a file only this user can read. It is never part of the app or the repo.
 * 2. This computer's identity (its machine id).
 * 3. This user account's name.
 *
 * So the bundle opens only for this user on this computer. Copying the bundle, or even
 * the bundle together with the secret file, to another machine gives nothing usable.
 */

const SECRET_LENGTH = 32;

async function machineIdentity(): Promise<string> {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = (await readFile(file, "utf8")).trim();
      if (id) return id;
    } catch {
      // try the next place
    }
  }
  // Systems without a machine id still get a binding, just a weaker one.
  return `host:${hostname()}`;
}

async function installSecret(file: string, create: boolean): Promise<Buffer | null> {
  try {
    const existing = await readFile(file);
    if (existing.length === SECRET_LENGTH) return existing;
    throw new Error(`The key file ${file} is damaged. Delete it and import the model again.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!create) return null;
  const secret = randomBytes(SECRET_LENGTH);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, secret, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  return secret;
}

/**
 * @param secretFile Where this install's random secret lives.
 * @param create Make the secret if there is none yet (when importing). When false and no
 *   secret exists, returns null: nothing was ever imported here.
 */
export async function modelKeyMaterial(
  secretFile: string,
  create: boolean,
): Promise<Buffer | null> {
  const secret = await installSecret(secretFile, create);
  if (!secret) return null;
  return Buffer.concat([
    secret,
    Buffer.from(
      `\u0000machine:${await machineIdentity()}\u0000user:${userInfo().username}\u0000`,
      "utf8",
    ),
  ]);
}
