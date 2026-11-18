/**
 * Name dictionary for free text (spec 6.4, step 4).
 *
 * Token based instead of one big regex: the dictionary holds every student of the school
 * (~1000 people, several spellings each), so texts are split into words and word sequences
 * (up to 4 words) are looked up in a map. Case-insensitive, Unicode-aware, longest match first.
 */

/** Common words that are also names – never replaced as a single word. Extend via REDACTION_KEEP_WORDS. */
export const STOPWORDS = new Set([
  "mai",
  "rose",
  "klein",
  "groß",
  "gross",
  "wolf",
  "fuchs",
  "weiß",
  "weiss",
  "schwarz",
  "braun",
  "lang",
  "kurz",
  "bach",
  "berg",
  "stein",
  "winter",
  "sommer",
  "frank",
  "ernst",
  "will",
  "kaiser",
  "könig",
  "koenig",
  "vogel",
  "hahn",
  "jung",
  "alt",
  "neu",
  "busch",
  "baum",
  "wald",
  "see",
  "licht",
  "kraft",
  "engel",
  "frei",
  "glück",
  "gut",
  "mann",
  "frau",
  "herr",
  "kind",
  "april",
  "august",
  "juni",
  "juli",
  "lehrer",
  "lehrerin",
  "may",
  "june",
  "grace",
  "hope",
  "joy",
  "mark",
  "bill",
  "rich",
  "young",
  "white",
  "black",
  "brown",
  "green",
  "teacher",
  "student",
  "kurs",
  "klasse",
  "test",
  "info",
  "raum",
  "sport",
  "kunst",
  "musik",
  "chemie",
  "physik",
  "bio",
  "ethik",
  "latein",
  "der",
  "die",
  "das",
  "und",
  "oder",
  "von",
  "van",
  "den",
]);

/** Salutations in front of teacher names ("Frau Hans Müller" → "Frau Müller"). Tokens without dots. */
export const SALUTATIONS = ["frau", "herr", "herrn", "fr", "hr", "dr", "mr", "mrs", "ms", "miss"];

const MIN_SINGLE_LEN = 3;
/**
 * Minimum length of a single part of a compound name ("Auf der Heide" → "Heide", never "Auf").
 * Short parts are mostly prepositions/articles that also occur as ordinary words.
 */
const MIN_NAME_PART_LEN = 4;
/** Name particles of 4+ letters that are never replaced on their own. */
const NAME_PARTICLES = new Set(["della", "delle", "dello", "dalla", "degli", "zwischen"]);
const MAX_TOKENS = 4;
/** Words: letters/digits incl. combining marks (decomposed input), joined by apostrophes or hyphens. */
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’-][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

/** Letters that NFD does not decompose. */
const SPECIAL_FOLD: Record<string, string> = { ß: "ss", ẞ: "ss", ø: "o", æ: "ae", œ: "oe", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i" };

/** Case- and diacritic-insensitive form used for matching ("Ibáñez" → "ibanez", "Ødegård" → "odegard"). */
export function foldName(s: string): string {
  let out = "";
  for (const ch of s) {
    const lower = ch.toLowerCase();
    out += SPECIAL_FOLD[lower] ?? lower.normalize("NFD").replace(/\p{M}/gu, "");
  }
  return out.replace(/’/g, "'");
}

/** Transliteration of umlauts and Nordic letters ("Müller" → "Mueller", "Søren" → "Soeren"), applied before folding. */
const transliterate = (s: string) =>
  s
    .replace(/[äöüÄÖÜ]/g, (c) => `${c.toLowerCase().normalize("NFD")[0]}e`)
    .replace(/[øØ]/g, "oe")
    .replace(/[æÆ]/g, "ae")
    .replace(/[åÅ]/g, "aa")
    .replace(/[ßẞ]/g, "ss");
/** Allowed between the words of a name: spaces, a comma ("Last, First"), a dot ("F. Last"). */
const SEPARATOR_RE = /^[\s,.]{1,3}$/;

/**
 * keep    = the text stays unchanged (teacher last names – they may be shown)
 * replace = the match is replaced by `replacement`
 * self    = the account owner (replacement "Ich"/"Me"); conflicts with others become the neutral label
 */
export type EntryKind = "keep" | "replace" | "self";
type Entry = { kind: EntryKind; replacement: string; owner: string };

/** Folded words of a text. */
export const tokenize = (s: string): string[] => [...(s ?? "").matchAll(TOKEN_RE)].map((m) => foldName(m[0]));

export class NameMatcher {
  private map = new Map<string, Entry>();
  private maxTokens = 1;

  constructor(
    /** Replacement for spellings shared by different people. */
    private ambiguous: string,
    /** Words never replaced as a single name (lowercase), in addition to STOPWORDS. */
    private keepWords: ReadonlySet<string> = new Set(),
  ) {}

  get size() {
    return this.map.size;
  }

  /** Registers one spelling (any casing, words separated by spaces/commas/dots). */
  add(phrase: string, kind: EntryKind, replacement: string, owner: string) {
    // Original spelling and German transliteration ("Müller" also matches "Mueller")
    for (const v of new Set([phrase, transliterate(phrase)])) this.addVariant(v, kind, replacement, owner);
  }

  private foldedStopwords?: Set<string>;
  private isStopword(t: string) {
    this.foldedStopwords ??= new Set([...STOPWORDS].map(foldName));
    return this.foldedStopwords.has(t);
  }

  private foldedKeepWords?: Set<string>;
  private isKeepWord(t: string) {
    this.foldedKeepWords ??= new Set([...this.keepWords].map(foldName));
    return this.foldedKeepWords.has(t);
  }

  private addVariant(phrase: string, kind: EntryKind, replacement: string, owner: string) {
    const tokens = tokenize(phrase);
    if (tokens.length === 0 || tokens.length > MAX_TOKENS) return;
    if (tokens.length === 1) {
      const t = tokens[0]!;
      if (t.length < MIN_SINGLE_LEN || /^\d+$/.test(t)) return;
      // The owner's own name is replaced even if it is a common word ("Wolf") – unless explicitly kept
      if (kind === "replace" && this.isStopword(t)) return;
      if (kind !== "keep" && this.isKeepWord(t)) return;
    }
    const key = tokens.join(" ");
    const next: Entry = { kind, replacement, owner };
    const existing = this.map.get(key);
    this.map.set(key, existing ? this.merge(existing, next) : next);
    this.maxTokens = Math.max(this.maxTokens, tokens.length);
  }

  private merge(a: Entry, b: Entry): Entry {
    if (a.owner === b.owner) return a;
    // The owner's name must never leak – but "Ich" would be wrong for the other person
    if (a.kind === "self" || b.kind === "self") return { kind: "replace", replacement: this.ambiguous, owner: "*" };
    if (a.kind === "keep") return a; // teacher last names win over students with the same last name
    if (b.kind === "keep") return b;
    if (a.replacement === b.replacement) return a;
    return { kind: "replace", replacement: this.ambiguous, owner: "*" };
  }

  apply(text: string): string {
    if (!text || this.map.size === 0) return text;
    const toks = [...text.matchAll(TOKEN_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, lower: foldName(m[0]) }));
    let out = "";
    let pos = 0;
    let i = 0;
    while (i < toks.length) {
      let matched = 0;
      let entry: Entry | undefined;
      for (let n = Math.min(this.maxTokens, toks.length - i); n >= 1; n--) {
        let ok = true;
        for (let j = i; j < i + n - 1; j++) {
          if (!SEPARATOR_RE.test(text.slice(toks[j]!.end, toks[j + 1]!.start))) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const key = toks
          .slice(i, i + n)
          .map((t) => t.lower)
          .join(" ");
        const e = this.map.get(key);
        if (e) {
          entry = e;
          matched = n;
          break;
        }
      }
      if (!entry) {
        i++;
        continue;
      }
      const start = toks[i]!.start;
      const end = toks[i + matched - 1]!.end;
      if (entry.kind !== "keep") {
        out += text.slice(pos, start) + entry.replacement;
        pos = end;
      }
      i += matched;
    }
    return out + text.slice(pos);
  }
}

export type NameParts = { firstName?: string | null; lastName?: string | null; displayName?: string | null };

const clean = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim();

/** Parts of a compound name that are matched on their own ("Anna-Lena" → "Anna", "Lena"; "Auf der Heide" → "Heide"). */
function compoundParts(s: string): string[] {
  const tokens = s.split(/[\s-]+/).filter(Boolean);
  if (tokens.length < 2) return [];
  return tokens.filter((x) => x.length >= MIN_NAME_PART_LEN && !NAME_PARTICLES.has(foldName(x)));
}

/**
 * All spellings of a person: "First Last", "Last First" (also matches "Last, First"), "F. Last", display name,
 * combinations with parts of compound names ("Anna Kornblum" for "Anna Lena Kornblum"), and the single words
 * (whole first and last name, parts of compound names with at least 4 letters).
 */
export function spellings(p: NameParts): { multi: string[]; firstParts: string[]; lastParts: string[] } {
  const first = clean(p.firstName);
  const last = clean(p.lastName);
  const firstParts = first ? [...new Set([first, ...compoundParts(first)])] : [];
  const lastParts = last ? [...new Set([last, ...compoundParts(last)])] : [];
  const multi = [clean(p.displayName)];
  if (first && last) {
    multi.push(`${last} ${first}`);
    for (const l of lastParts) {
      for (const f of firstParts) multi.push(`${f} ${l}`);
      multi.push(`${first[0]}. ${l}`);
    }
  }
  return { multi: [...new Set(multi.filter(Boolean))], firstParts, lastParts };
}

/** Parses REDACTION_KEEP_WORDS (comma-separated) into a lowercase set. */
export function parseKeepWords(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean),
  );
}

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
const PHONE_RE = /(?<![\p{L}\p{N}])(?:\+|0)[\d][\d \t/().-]{5,}\d(?![\p{L}\p{N}])/gu;
const DATE_LIKE_RE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;

export function redactContacts(text: string, labels: { email: string; phone: string }): string {
  return text.replace(EMAIL_RE, labels.email).replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, "").length;
    if (digits < 7 || DATE_LIKE_RE.test(m.trim())) return m;
    return labels.phone;
  });
}
