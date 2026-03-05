import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function getKey(): Buffer | null {
  const hex = process.env.CONFIG_ENCRYPTION_KEY;
  if (!hex) return null;
  if (hex.length !== 64) {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY must be 64 hex characters (32 bytes). " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex, "hex");
}

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * If CONFIG_ENCRYPTION_KEY is not set, stores plaintext with null iv/tag (dev mode).
 */
export function encrypt(plaintext: string): EncryptedValue {
  const key = getKey();
  if (!key) {
    // Dev mode: store plaintext as-is
    return { ciphertext: plaintext, iv: "", tag: "" };
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

/**
 * Decrypt a ciphertext string using AES-256-GCM.
 * If iv/tag are empty (dev mode), returns ciphertext as plaintext.
 */
export function decrypt(ciphertext: string, iv: string, tag: string): string {
  if (!iv && !tag) {
    // Dev mode: ciphertext is actually plaintext
    return ciphertext;
  }

  const key = getKey();
  if (!key) {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY is required to decrypt stored keys. " +
      "Set the same key that was used during encryption."
    );
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
