import { DatabaseSync } from "node:sqlite";
import { decodeServed } from "./decode.mjs";
function canon(l){return l.replace(/[ \t\r\n]+/g,"");}
function cyrb53(str, seed=0){let h1=0xdeadbeef^seed,h2=0x41c6ce57^seed;for(let i=0;i<str.length;i++){const ch=str.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677);}h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);return 4294967296*(2097151&h2)+(h1>>>0);}
const ck=(l)=>cyrb53(canon(l));
const A="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function decodeDense(raw){ // legacy dense array
  try { const p=JSON.parse(raw); if(Array.isArray(p)) return p; } catch {}
  return undefined;
}
for (const src of process.argv.slice(2)) {
  const d = new DatabaseSync(src);
  console.log("=".repeat(72)); console.log(src);
  const paths = [...new Set(d.prepare("SELECT DISTINCT path FROM served UNION SELECT DISTINCT path FROM anchor_meta UNION SELECT DISTINCT path FROM undo").all().map(r=>r.path))];
  let servedSlots=0, live=0, released=0, reallocOtherLine=0, reallocDifferentKey=0, unknown=0;
  const examples=[];
  for (const path of paths) {
    // histories: anchor -> Set("line:key")
    const hist = new Map();
    const note = (a, line, key) => { if(!a) return; let m=hist.get(a); if(!m){m=new Set();hist.set(a,m);} m.add(line+":"+key); };
    for (const u of d.prepare("SELECT content, hashes, updated_at FROM undo WHERE path=? ORDER BY depth").all(path)) {
      let arr; try { arr = JSON.parse(u.hashes); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      const lines = u.content.split("\n");
      arr.forEach((a,i)=>{ if(typeof a==="string"&&a!=="") note(a, i+1, ck(lines[i]??"")); });
    }
    for (const s of d.prepare("SELECT hashes FROM served WHERE path=?").all(path)) {
      const dec = decodeServed(s.hashes); if(!dec?.anchors) continue;
      for (const a of dec.anchors) servedSlots++;
      for (const a of dec.anchors) {
        const cur = d.prepare("SELECT line, content_key FROM anchor_lines WHERE path=? AND anchor=?").get(path, a);
        const h = hist.get(a);
        if (!h) { if (cur) live++; else unknown++; continue; }
        if (!cur) { released++; continue; }
        const curTok = cur.line + ":" + cur.content_key;
        if (h.has(curTok)) live++;
        else {
          reallocOtherLine++;
          // same content key, different line?
          const sameKey = [...h].some(tok => tok.split(":")[1] === String(cur.content_key));
          if (!sameKey) reallocDifferentKey++;
          if (examples.length < 12) examples.push({path: path.slice(-40), anchor: a, history: [...h].slice(0,3), now: curTok});
        }
      }
    }
  }
  console.log(`served anchor-slots=${servedSlots}`);
  console.log(`  still bound to the SAME (line, contentKey) as the last recorded state : ${live}`);
  console.log(`  not in anchor_lines at all (released / evicted)                       : ${released}  (incl. ${unknown} with no recoverable undo history)`);
  console.log(`  LIVE at a DIFFERENT (line, contentKey) than any recorded state        : ${reallocOtherLine}`);
  console.log(`    ... of those, at a different CONTENT (true rebind to other content) : ${reallocDifferentKey}`);
  console.log(`  examples: ${JSON.stringify(examples.slice(0,6), null, 1)}`);
  d.close();
}
