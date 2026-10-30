export function show(s: string): string {
  return JSON.stringify(s);
}

export function sup(n: number): string {
  return String(n).replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)]);
}

/**
 * Split a "/pattern/flags" literal into parts. Returns null for anything that
 * isn't a valid literal, such as "/usr/bin/" with its unescaped inner slash.
 */
export function parseInput(input: string): { source: string; flags: string } | null {
  const m = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(input.trim());
  if (!m) return null;

  let inClass = false;
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === "\\") i++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return null;
  }
  return { source: m[1], flags: m[2] };
}
