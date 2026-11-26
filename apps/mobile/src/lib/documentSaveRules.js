// The pure rules of "Download" on Documents & Reports (no React, no native modules): which errors mean the person cancelled, and how a file name is kept when the folder already has one of that name.

// The person cancelled (nothing is shown, nothing failed).
export function isSaveCancelled(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'save_cancelled' || err.code === 'ERR_CANCELED' || err.code === 'ERR_SHARING_CANCELLED') return true;
  return /cancel/i.test(String(err.code || '')) || /cancel/i.test(String(err.message || ''));
}

// "Report.pdf" -> "Report.pdf"; when taken: "Report (1).pdf", "Report (2).pdf" ... The extension and the name are kept; a name with no extension gets the number at its end. `taken` is a list or a Set of names
// already in the folder (compared without regard to case, as the phone's file systems do).
export function uniqueName(name, taken) {
  const used = new Set([...(taken || [])].map((n) => String(n).toLowerCase()));
  if (!used.has(String(name).toLowerCase())) return name;
  const dot = String(name).lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${base} (${n})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}
