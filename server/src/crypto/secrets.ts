import crypto from "crypto";
import { env } from "../env";

function key(): Buffer {
  if (!env.SECRETS_KEY_B64) {
    throw new Error("Missing SECRETS_KEY_B64 (32 bytes base64) for secret encryption");
  }
  const k = Buffer.from(env.SECRETS_KEY_B64, "base64");
  if (k.length !== 32) throw new Error("SECRETS_KEY_B64 must decode to 32 bytes");
  return k;
}

export function encryptJson(obj: unknown): { iv: string; tag: string; data: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = Buffer.from(JSON.stringify(obj), "utf-8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), tag: tag.toString("base64"), data: encrypted.toString("base64") };
}

export function decryptJson(payload: { iv: string; tag: string; data: string }): unknown {
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const data = Buffer.from(payload.data, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
  return JSON.parse(plain);
}
