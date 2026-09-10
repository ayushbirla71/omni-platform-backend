import crypto from "crypto";
import { logger } from "./logger";

// Master key resolution - derived to 32 bytes (256 bits)
const MASTER_SECRET =
  process.env.ENCRYPTION_KEY ||
  process.env.JWT_SECRET ||
  "omni-platform-master-encryption-key-32-bytes-prod";

const DERIVED_KEY = crypto.createHash("sha256").update(MASTER_SECRET).digest();
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

export interface EncryptedEnvelope {
  __encrypted: true;
  v: number;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Encrypt an arbitrary JavaScript object/dictionary with AES-256-GCM.
 */
export function encryptObject(obj: Record<string, any> | null | undefined): Record<string, any> {
  if (!obj || typeof obj !== "object" || Object.keys(obj).length === 0) {
    return obj || {};
  }

  // Already encrypted?
  if ((obj as any).__encrypted === true) {
    return obj;
  }

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, DERIVED_KEY, iv);

    const plaintext = JSON.stringify(obj);
    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");

    const tag = cipher.getAuthTag();

    const envelope: EncryptedEnvelope = {
      __encrypted: true,
      v: 1,
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      data: encrypted,
    };

    return envelope as unknown as Record<string, any>;
  } catch (error: any) {
    logger.error("Failed to encrypt object with AES-256-GCM", { error: error?.message });
    return obj;
  }
}

/**
 * Decrypt an AES-256-GCM encrypted envelope.
 * If the object is not encrypted (legacy records), it is returned as-is for backward compatibility.
 */
export function decryptObject<T = Record<string, any>>(obj: any): T {
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  // Check if it has the encrypted envelope signature
  if (obj.__encrypted !== true || !obj.iv || !obj.tag || !obj.data) {
    return obj as T;
  }

  try {
    const iv = Buffer.from(obj.iv, "hex");
    const tag = Buffer.from(obj.tag, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, DERIVED_KEY, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(obj.data, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return JSON.parse(decrypted) as T;
  } catch (error: any) {
    logger.error("Failed to decrypt AES-256-GCM envelope", { error: error?.message });
    return obj as T;
  }
}

/**
 * Generate HMAC-SHA256 signature for outbound webhooks
 */
export function generateHmacSignature(payload: string | Buffer | Record<string, any>, secret: string): string {
  const content = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
  const hmac = crypto.createHmac("sha256", secret).update(content).digest("hex");
  return `sha256=${hmac}`;
}

/**
 * Verify HMAC-SHA256 signature timing-safely
 */
export function verifyHmacSignature(payload: string | Buffer | Record<string, any>, signature: string, secret: string): boolean {
  try {
    const expected = generateHmacSignature(payload, secret);
    const sigA = Buffer.from(signature);
    const sigB = Buffer.from(expected);
    if (sigA.length !== sigB.length) return false;
    return crypto.timingSafeEqual(sigA, sigB);
  } catch {
    return false;
  }
}

/**
 * Generate a cryptographically secure random webhook secret
 */
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString("hex")}`;
}
