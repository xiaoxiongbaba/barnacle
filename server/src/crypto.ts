import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Encrypts provider API keys at rest (AES-256-GCM). The key file lives next to the database, so this
 * protects against a leaked database file or backup, not against someone who can read the whole data dir.
 */
const keyFile = path.join(config.dataDir, "master.key");

function masterKey(): Buffer {
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString("base64"), { mode: 0o600 });
  return key;
}

const key = masterKey();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decrypt(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
