// Lightweight sentence splitter for English text.
// Returns array of sentences (with trailing punctuation kept), trimmed.
export function splitSentences(text = "") {
  const s = String(text || "").trim();
  if (!s) return [];

  // Split on sentence-ending punctuation followed by space or end.
  const re = /[^.!?…]*[.!?…]+(?:["”’']+)?(?:\s+|$)/g;
  const out = [];
  let m;
  let lastEnd = 0;
  while ((m = re.exec(s)) !== null) {
    const frag = m[0].trim();
    if (frag) out.push(frag);
    lastEnd = re.lastIndex;
  }

  // Tail (no ending punct) treated as last chunk.
  const tail = s.slice(lastEnd).trim();
  if (tail) out.push(tail);

  return out;
}
