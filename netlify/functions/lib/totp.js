// TOTP (RFC 6238) com HMAC-SHA1, passo de 30s, 6 dígitos — autenticadores
// (Google Authenticator, Authy, 1Password, Microsoft Authenticator, etc.).
// Implementado só com crypto nativo do Node (sem dependências externas).
import { createHmac, randomBytes } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP = 30;
const DIGITS = 6;

// Segredo aleatório em base32 (20 bytes = 160 bits, padrão para TOTP).
export function generateSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || "").replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) |
              ((hmac[offset + 1] & 0xff) << 16) |
              ((hmac[offset + 2] & 0xff) << 8) |
              (hmac[offset + 3] & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

export function totp(secretBase32, t = Date.now()) {
  return hotp(base32Decode(secretBase32), Math.floor(t / 1000 / STEP));
}

// Verifica com janela de tolerância (±window passos => ±30s por passo).
export function verifyTotp(token, secretBase32, window = 1, t = Date.now()) {
  const code = String(token || "").replace(/\D/g, "");
  if (code.length !== DIGITS) return false;
  const counter = Math.floor(t / 1000 / STEP);
  const secretBuf = base32Decode(secretBase32);
  for (let i = -window; i <= window; i++) {
    if (hotp(secretBuf, counter + i) === code) return true;
  }
  return false;
}

// URI otpauth:// para gerar o QR code no autenticador.
export function keyuri({ secret, label, issuer = "DPO PJ Protection" }) {
  const path = encodeURIComponent(issuer) + ":" + encodeURIComponent(label);
  const params = new URLSearchParams({
    secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP),
  });
  return `otpauth://totp/${path}?${params.toString()}`;
}
