export const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function decodeServed(raw) {
  if (typeof raw !== "string") return undefined;
  if (!raw.startsWith("~1")) return { legacy: raw };
  const bytes = Buffer.from(raw.slice(2), "base64");
  let at = 0;
  const rv = () => { let v = 0, s = 1; for (;;) { if (at >= bytes.length) throw new Error("eof"); const b = bytes[at++]; v += (b & 0x7f) * s; if (!(b & 0x80)) return v; s *= 0x80; } };
  const out = [];
  const groups = rv();
  for (let g = 0; g < groups; g++) {
    const len = rv(); const cnt = rv(); let prev = 0;
    for (let i = 0; i < cnt; i++) { prev += rv(); let s = "", rest = prev; for (let j = 0; j < len; j++) { s = BASE62[rest % 62] + s; rest = Math.floor(rest / 62); } out.push(s); }
  }
  return { anchors: out };
}
