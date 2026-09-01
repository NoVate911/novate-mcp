import {
  createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual,
} from "node:crypto";

const KDF_CONTEXT = "novate-mcp/session-signing-key/v1";
// Отдельный контекст для CSRF: токен формы никогда не совпадёт с ключом сессии.
const CSRF_CONTEXT = "novate-mcp/csrf-token/v1";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

type SessionRecord = Record<string, unknown>;

/** base64url без выравнивания. Единственная реализация в проекте. */
export function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** AES-256-GCM session codec with a memory-hard key derived from SESSION_SECRET. */
export function createSessionCodec(getSecret: () => string) {
  let cachedSecret = "";
  let cachedKey: Buffer | null = null;

  const key = (): Buffer => {
    const secret = getSecret();
    if (!secret) throw new Error("SESSION_SECRET is empty");
    if (!cachedKey || secret !== cachedSecret) {
      cachedSecret = secret;
      cachedKey = scryptSync(secret, KDF_CONTEXT, 32, {
        N: 1 << 15,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      });
    }
    return cachedKey;
  };

  const packSigned = (payload: SessionRecord): string => {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key(), nonce);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `${b64url(nonce)}.${b64url(ciphertext)}.${b64url(cipher.getAuthTag())}`;
  };

  const unpackSigned = (cookie: string, ttl: number, now = Math.floor(Date.now() / 1000)): SessionRecord | null => {
    const parts = cookie.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) return null;
    try {
      const nonce = Buffer.from(parts[0]!, "base64url");
      const ciphertext = Buffer.from(parts[1]!, "base64url");
      const authTag = Buffer.from(parts[2]!, "base64url");
      if (nonce.length !== NONCE_BYTES || authTag.length !== AUTH_TAG_BYTES || !ciphertext.length) return null;
      const decipher = createDecipheriv("aes-256-gcm", key(), nonce);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const data = JSON.parse(plaintext.toString("utf8")) as SessionRecord;
      if (typeof data.ts !== "number") return null;
      const age = now - data.ts;
      if (age < 0 || age > ttl) return null;
      return data;
    } catch {
      return null;
    }
  };

  /**
   * CSRF-токен формы: HMAC от идентификатора пользователя на ключе,
   * выведенном из SESSION_SECRET. Значение недоступно сторонним сайтам,
   * поэтому годится как synchronizer token.
   * Проверка по Origin здесь работать не может: Caddy отдаёт
   * Referrer-Policy: no-referrer, и браузер присылает Origin: null.
   */
  const csrfToken = (uid: string): string =>
    b64url(createHmac("sha256", key()).update(`${CSRF_CONTEXT}|${uid}`).digest());

  const csrfMatches = (uid: string, supplied: string): boolean => {
    if (!uid || !supplied) return false;
    const expected = Buffer.from(csrfToken(uid), "utf8");
    const actual = Buffer.from(supplied, "utf8");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  };

  return { packSigned, unpackSigned, csrfToken, csrfMatches };
}
