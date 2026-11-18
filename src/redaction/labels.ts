/**
 * Labels and placeholders inserted by the redaction (spec 6.3), per REDACTION_LANGUAGE.
 */
export type Language = "de" | "en";
export const LANGUAGES: Language[] = ["de", "en"];

export type Labels = {
  self: string;
  /** Prefixes for pseudonyms: `${prefix}-7F3A` */
  teacherPrefix: string;
  studentPrefix: string;
  parentPrefix: string;
  personPrefix: string;
  /** Replacement for names that cannot be attributed (ambiguous, first names of teachers). */
  name: string;
  email: string;
  phone: string;
  linkRemoved: string;
  untisLink: string;
  encodedData: string;
  idPair: string;
  image: string;
};

export const LABELS: Record<Language, Labels> = {
  de: {
    self: "Ich",
    teacherPrefix: "Lehrkraft",
    studentPrefix: "Schüler:in",
    parentPrefix: "Elternteil",
    personPrefix: "Person",
    name: "[Name]",
    email: "[E-Mail]",
    phone: "[Telefon]",
    linkRemoved: "[Link entfernt]",
    untisLink: "[WebUntis-Link]",
    encodedData: "[kodierte Daten entfernt]",
    idPair: "[ID]",
    image: "[Bild]",
  },
  en: {
    self: "Me",
    teacherPrefix: "Teacher",
    studentPrefix: "Student",
    parentPrefix: "Parent",
    personPrefix: "Person",
    name: "[name]",
    email: "[email]",
    phone: "[phone]",
    linkRemoved: "[link removed]",
    untisLink: "[WebUntis link]",
    encodedData: "[encoded data removed]",
    idPair: "[ID]",
    image: "[image]",
  },
};

export const getLabels = (lang: Language): Labels => LABELS[lang];
