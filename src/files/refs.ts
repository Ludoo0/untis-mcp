/**
 * fileRefs (spec 5.11): contain only Untis ids and dates – no secrets – and are resolvable statelessly.
 *   m_<messageId>_<n>              message attachment
 *   h_<yyyymmdd>_<homeworkId>_<n>  homework attachment (date = day the homework was given)
 *   d_<yyyymmdd>_<n>_<k>           attachment k of message-of-the-day n
 *   l_<yyyymmdd>_<periodId>_<n>    lesson file (teaching content / notes)
 */
export type FileRef =
  | { kind: "m"; messageId: number; n: number }
  | { kind: "h"; date: string; homeworkId: number; n: number }
  | { kind: "d"; date: string; n: number; k: number }
  | { kind: "l"; date: string; periodId: number; n: number };

const compact = (iso: string) => iso.replace(/-/g, "");
const expand = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

export function formatRef(r: FileRef): string {
  switch (r.kind) {
    case "m":
      return `m_${r.messageId}_${r.n}`;
    case "h":
      return `h_${compact(r.date)}_${r.homeworkId}_${r.n}`;
    case "d":
      return `d_${compact(r.date)}_${r.n}_${r.k}`;
    case "l":
      return `l_${compact(r.date)}_${r.periodId}_${r.n}`;
  }
}

export function parseRef(s: string): FileRef | undefined {
  let m = s.match(/^m_(\d{1,12})_(\d{1,3})$/);
  if (m) return { kind: "m", messageId: Number(m[1]), n: Number(m[2]) };
  m = s.match(/^h_(\d{8})_(\d{1,12})_(\d{1,3})$/);
  if (m) return { kind: "h", date: expand(m[1]!), homeworkId: Number(m[2]), n: Number(m[3]) };
  m = s.match(/^d_(\d{8})_(\d{1,3})_(\d{1,3})$/);
  if (m) return { kind: "d", date: expand(m[1]!), n: Number(m[2]), k: Number(m[3]) };
  m = s.match(/^l_(\d{8})_(\d{1,12})_(\d{1,3})$/);
  if (m) return { kind: "l", date: expand(m[1]!), periodId: Number(m[2]), n: Number(m[3]) };
  return undefined;
}
