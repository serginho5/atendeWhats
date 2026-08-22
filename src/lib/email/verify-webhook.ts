import { createHmac, timingSafeEqual } from "node:crypto";

// Verifica a assinatura do Supabase Auth "Send Email Hook", que segue a spec
// Standard Webhooks (mesma usada pelo Svix): assina `${id}.${timestamp}.${body}`
// com HMAC-SHA256 usando o secret gerado no dashboard do Supabase
// (Authentication > Hooks), no formato "v1,whsec_<base64>".
export function verifySupabaseWebhook(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  const secretKey = secret.replace(/^v1,?/, "").replace(/^whsec_/, "");
  const secretBytes = Buffer.from(secretKey, "base64");

  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(signedContent).digest("base64");

  return headers.signature
    .split(" ")
    .map((s) => s.split(",")[1])
    .filter(Boolean)
    .some((sig) => {
      try {
        const a = Buffer.from(sig);
        const b = Buffer.from(expected);
        return a.length === b.length && timingSafeEqual(a, b);
      } catch {
        return false;
      }
    });
}
