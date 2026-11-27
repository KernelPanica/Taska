import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Заголовок внешней страницы для блока ссылок (R-2.24). Сервер сам ходит по адресу, поэтому защищён
 * от SSRF: только http(s), без адресов внутренней сети (кроме разработки), не больше 3 переадресаций,
 * 3 секунды и 256 КБ на ответ. Не вышло — ссылка сохраняется без заголовка.
 */
const MAX_BYTES = 256 * 1024;

function privateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80")
    )
      return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? privateAddress(mapped[1] as string) : false;
  }
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

async function safe(url: URL, allowPrivate: boolean) {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (allowPrivate) return true;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((item) => item.address);
  return addresses.length > 0 && !addresses.some(privateAddress);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, " ")
    .trim();
}

/** Заголовок из HTML: og:title, затем <title>. */
export function titleFromHtml(html: string): string | null {
  const og =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const title = og?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const text = title ? decode(title).slice(0, 300) : "";
  return text || null;
}

export async function fetchTitle(raw: string, allowPrivate: boolean): Promise<string | null> {
  try {
    let url = new URL(raw);
    for (let hop = 0; hop < 4; hop += 1) {
      if (!(await safe(url, allowPrivate))) return null;
      const response = await fetch(url, {
        redirect: "manual",
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": "YourTask link preview" },
        signal: AbortSignal.timeout(3000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return null;
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !(response.headers.get("content-type") ?? "").includes("html")) return null;
      const reader = response.body?.getReader();
      if (!reader) return null;
      let received = 0;
      let html = "";
      const decoder = new TextDecoder();
      while (received < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (/<\/title>/i.test(html) && /<\/head>/i.test(html)) break;
      }
      await reader.cancel().catch(() => undefined);
      return titleFromHtml(html);
    }
    return null;
  } catch {
    return null;
  }
}
