import type { FileKind } from "@yourtask/contracts";

/**
 * Тип файла по содержимому (R-2.24): первые байты сверяются с сигнатурами. Расширение должно совпасть
 * с найденным типом, иначе файл отклоняется — «картинка.png», которая на деле HTML, не пройдёт.
 */
const starts = (head: Buffer, bytes: number[], at = 0) => bytes.every((byte, index) => head[at + index] === byte);
const ascii = (head: Buffer, text: string, at = 0) => head.subarray(at, at + text.length).toString("latin1") === text;

/** Похоже на текст: валидный UTF-8, без нулевых байт и управляющих символов (кроме переводов строк и табуляции). */
function looksLikeText(head: Buffer) {
  if (head.includes(0)) return false;
  // Последний символ мог быть обрезан на границе блока — проверяем без него.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head.subarray(0, Math.max(0, head.length - 4)));
  if (text.includes("�")) return false;
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
}

/** Какие типы подходят под содержимое (у текста и zip-контейнеров их несколько). */
export function sniff(head: Buffer): FileKind[] {
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ["png"];
  if (starts(head, [0xff, 0xd8, 0xff])) return ["jpg"];
  if (ascii(head, "GIF87a") || ascii(head, "GIF89a")) return ["gif"];
  if (ascii(head, "RIFF") && ascii(head, "WEBP", 8)) return ["webp"];
  if (ascii(head, "ftyp", 4)) return ascii(head, "qt  ", 8) ? ["mov", "mp4"] : ["mp4", "mov"];
  if (starts(head, [0x1a, 0x45, 0xdf, 0xa3])) return ["webm"];
  if (ascii(head, "%PDF-")) return ["pdf"];
  // Документы Office — zip-контейнеры; отдельный zip тоже.
  if (starts(head, [0x50, 0x4b, 0x03, 0x04]) || starts(head, [0x50, 0x4b, 0x05, 0x06]))
    return ["docx", "xlsx", "pptx", "zip"];
  // Текст, в котором есть разметка HTML, текстом не считаем: браузер мог бы его исполнить.
  if (looksLikeText(head) && !/<\s*(script|html|svg|iframe)/i.test(head.toString("utf8"))) return ["txt", "md", "csv"];
  return [];
}
