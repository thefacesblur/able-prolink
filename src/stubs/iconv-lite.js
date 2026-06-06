// Stub: iconv-lite only needed for legacy CD encoding; remote DB returns standard Unicode.
export function decode(buf, enc) {
  return typeof buf === "string" ? buf : buf.toString("utf8");
}
export function encode(str) {
  return Buffer.from(str, "utf8");
}
export function encodingExists() {
  return false;
}
