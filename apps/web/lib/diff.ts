/** Word-level diff (LCS) for the before/after view of proposed changes. */
export type Piece = { text: string; kind: "same" | "add" | "del" };

export function wordDiff(a: string, b: string): Piece[] {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  if (A.length * B.length > 400_000) return [{ text: a, kind: "del" }, { text: b, kind: "add" }];
  const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Piece[] = [];
  const push = (text: string, kind: Piece["kind"]) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      push(A[i]!, "same");
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push(A[i++]!, "del");
    else push(B[j++]!, "add");
  }
  while (i < A.length) push(A[i++]!, "del");
  while (j < B.length) push(B[j++]!, "add");
  return out;
}
