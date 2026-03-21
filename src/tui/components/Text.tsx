import { Text as InkText, type TextProps } from "ink";
import type { ReactNode } from "react";

const decoder = new TextDecoder("utf-8", { fatal: false });

function isContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function looksLikeMojibake(value: string): boolean {
  let sawUtf8Sequence = false;
  for (let index = 0; index < value.length; index += 1) {
    const byte = value.charCodeAt(index);
    if (byte > 0xff) return false;
    if (byte >= 0xc2 && byte <= 0xdf) {
      if (
        index + 1 < value.length &&
        isContinuationByte(value.charCodeAt(index + 1))
      ) {
        sawUtf8Sequence = true;
        index += 1;
        continue;
      }
    }
    if (byte >= 0xe0 && byte <= 0xef) {
      if (
        index + 2 < value.length &&
        isContinuationByte(value.charCodeAt(index + 1)) &&
        isContinuationByte(value.charCodeAt(index + 2))
      ) {
        sawUtf8Sequence = true;
        index += 2;
        continue;
      }
    }
    if (byte >= 0xf0 && byte <= 0xf4) {
      if (
        index + 3 < value.length &&
        isContinuationByte(value.charCodeAt(index + 1)) &&
        isContinuationByte(value.charCodeAt(index + 2)) &&
        isContinuationByte(value.charCodeAt(index + 3))
      ) {
        sawUtf8Sequence = true;
        index += 3;
      }
    }
  }
  return sawUtf8Sequence;
}

function fixTextEncoding(value: ReactNode): ReactNode {
  if (typeof value === "string") {
    if (!/[\x80-\xFF]/.test(value)) return value;
    if (!looksLikeMojibake(value)) return value;
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      bytes[index] = value.charCodeAt(index);
    }
    const decoded = decoder.decode(bytes);
    if (decoded.includes("\uFFFD")) {
      return value;
    }
    return decoded;
  }
  if (Array.isArray(value)) {
    return value.map(fixTextEncoding);
  }
  return value;
}

export function Text({ children, ...props }: TextProps) {
  return <InkText {...props}>{fixTextEncoding(children)}</InkText>;
}
