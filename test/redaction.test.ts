import { describe, expect, test } from "bun:test";
import { LABELS } from "../src/redaction/labels";
import { NameMatcher } from "../src/redaction/names";
import { PersonRegistry } from "../src/redaction/people";
import { Redactor } from "../src/redaction/redactor";
import { isShareableUrl, redactUrlForLog, stripSecretUrls } from "../src/redaction/secrets";
import { TeacherDirectory } from "../src/redaction/teachers";

function setup(opts: { redactTeachers?: boolean; keepAbbreviations?: boolean } = {}) {
  const people = new PersonRegistry({
    secret: "s3cr3t-for-tests-only",
    scope: "test",
    labels: LABELS.de,
    directory: new TeacherDirectory(null),
    ...opts,
  });
  people.setSelf(501, { firstName: "Jonas", lastName: "Beispielmann", displayName: "Beispielmann Jonas" });
  people.addTeachers([
    { id: 11, abbreviation: "LIN", firstName: "Sabine", lastName: "Lindqvist" },
    { id: 12, abbreviation: "MÜL", firstName: "Hans", lastName: "Müller" },
  ]);
  people.addStudents([
    { id: 501, firstName: "Jonas", lastName: "Beispielmann" },
    { id: 502, firstName: "Mia", lastName: "Sonnberg" },
    { id: 503, firstName: "Lea", lastName: "Müller" },
    { id: 504, firstName: "Anna Lena", lastName: "Kornblum" },
  ]);
  return { people, r: new Redactor(people) };
}

describe("name dictionary", () => {
  test("own name → Ich, in all spellings", () => {
    const { r } = setup();
    expect(r.text("Jonas Beispielmann fehlt")).toBe("Ich fehlt");
    expect(r.text("Beispielmann, Jonas")).toBe("Ich");
    expect(r.text("J. Beispielmann und JONAS")).toBe("Ich und Ich");
  });

  test("teachers: first names removed, last names kept", () => {
    const { r } = setup();
    expect(r.text("Vertretung durch Hans Müller")).toBe("Vertretung durch Müller");
    expect(r.text("Frau Sabine Lindqvist")).toBe("Frau Lindqvist");
    expect(r.text("Lindqvist, Sabine")).toBe("Lindqvist");
    expect(r.text("Gruß, Sabine")).toBe("Gruß, [Name]");
    expect(r.text("Herr Müller kommt")).toBe("Herr Müller kommt");
  });

  test("students become stable pseudonyms; last name shared with a teacher stays (teacher wins)", () => {
    const { r } = setup();
    const a = r.text("Mia Sonnberg bringt die Liste");
    expect(a).toMatch(/^Schüler:in-[0-9A-F]{4} bringt die Liste$/);
    expect(r.text("Sonnberg")).toBe(a.split(" ")[0]!);
    expect(r.text("Lea Müller")).toMatch(/^Schüler:in-[0-9A-F]{4}$/);
    expect(r.text("Müller")).toBe("Müller");
  });

  test("double first names: each part and the whole", () => {
    const { r } = setup();
    expect(r.text("Anna Lena Kornblum")).toMatch(/^Schüler:in-[0-9A-F]{4}$/);
    expect(r.text("Lena")).toMatch(/^Schüler:in-[0-9A-F]{4}$/);
  });

  test("stop words and short words are not replaced", () => {
    const m = new NameMatcher("[Name]");
    m.add("Will", "replace", "X", "a");
    m.add("Al", "replace", "X", "a");
    expect(m.apply("Ich will Al sehen")).toBe("Ich will Al sehen");
  });

  test("same spelling for different people → neutral label; conflicts with the owner never say Ich", () => {
    const m = new NameMatcher("[Name]");
    m.add("Kim", "replace", "Schüler:in-AAAA", "s1");
    m.add("Kim", "replace", "Schüler:in-BBBB", "s2");
    m.add("Kranich", "self", "Ich", "self");
    m.add("Kranich", "keep", "Kranich", "t1");
    expect(m.apply("Kim und Kranich")).toBe("[Name] und [Name]");
  });

  test("REDACT_TEACHERS pseudonymises teachers also in free text", () => {
    const { r, people } = setup({ redactTeachers: true });
    expect(people.teacher({ abbreviation: "LIN" }).name).toMatch(/^Lehrkraft-[0-9A-F]{4}$/);
    expect(people.teacher({ abbreviation: "LIN" }).abbreviation).toBeUndefined();
    expect(r.text("Frau Lindqvist")).toMatch(/^Frau Lehrkraft-[0-9A-F]{4}$/);
  });

  test("structured teacher: last name + abbreviation, never first name", () => {
    const { people } = setup();
    expect(people.teacher({ id: 12 })).toEqual({ name: "Müller", abbreviation: "MÜL" });
    expect(people.teacher({ abbreviation: "LIN", status: "removed" })).toEqual({
      name: "Lindqvist",
      abbreviation: "LIN",
      status: "removed",
    });
    expect(setup({ keepAbbreviations: false }).people.teacher({ id: 12 })).toEqual({ name: "Müller" });
    // Unknown teacher: given last name goes through the dictionary
    expect(people.teacher({ abbreviation: "XYZ", lastName: "Sabine Neu" }).name).toBe("[Name] Neu");
  });

  test("message senders by display name", () => {
    const { people } = setup();
    expect(people.personByName("Müller Hans", "u1")).toEqual({ display: "Müller", role: "teacher" });
    expect(people.personByName("Beispielmann Jonas", "u2")).toEqual({ display: "Ich", role: "self" });
    expect(people.personByName("Sonnberg Mia", "u3").role).toBe("student");
    const parent = people.personByName("Ottilie Brennecke", "u4", "PARENT");
    expect(parent.display).toMatch(/^Elternteil-[0-9A-F]{4}$/);
    // …and afterwards the parent is known in free text
    expect(new Redactor(people).text("Gruß Ottilie Brennecke")).toBe(`Gruß ${parent.display}`);
  });

  test("pseudonyms are stable for the same secret and differ for another secret", () => {
    const a = setup().r.text("Mia Sonnberg");
    const b = setup().r.text("Mia Sonnberg");
    expect(a).toBe(b);
    const other = new PersonRegistry({ secret: "another-secret-123456", scope: "test" });
    other.addStudents([{ id: 502, firstName: "Mia", lastName: "Sonnberg" }]);
    expect(new Redactor(other).text("Mia Sonnberg")).not.toBe(a);
  });

  test("scales to a whole school", () => {
    const people = new PersonRegistry({ secret: "s3cr3t-for-tests-only", scope: "test" });
    people.addStudents(Array.from({ length: 1500 }, (_, i) => ({ id: i, firstName: `Vorname${i}`, lastName: `Nachname${i}` })));
    const r = new Redactor(people);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) r.text("Vorname77 Nachname77 und Vorname1200 haben heute Sport. ".repeat(20));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(r.text("Vorname77 Nachname77")).toMatch(/^Person-|^Schüler:in-/);
  });
});

describe("contacts, URLs and secrets", () => {
  test("emails and phone numbers", () => {
    const { r } = setup();
    expect(r.text("Mail an a.b@example.org oder 0421 1234567")).toBe("Mail an [E-Mail] oder [Telefon]");
    expect(r.text("am 12.11.2026 um 08:00")).toBe("am 12.11.2026 um 08:00");
  });

  test("WebUntis and storage links are removed, harmless external links stay", () => {
    expect(isShareableUrl("https://www.example.org/info")).toBe(true);
    expect(isShareableUrl("https://school.webuntis.com/WebUntis/")).toBe(false);
    expect(isShareableUrl("https://bucket.s3.amazonaws.com/x.pdf")).toBe(false);
    expect(isShareableUrl("https://www.example.org/?token=abc")).toBe(false);
    expect(stripSecretUrls("siehe https://school.webuntis.com/WebUntis/?school=x.", LABELS.de)).toBe("siehe [WebUntis-Link].");
    expect(stripSecretUrls("untis://setschool?url=a&key=SECRET", LABELS.de)).toBe("[WebUntis-Link]");
    expect(stripSecretUrls("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl", LABELS.de)).toBe("jwt [Link entfernt]");
    expect(stripSecretUrls("personId=123", LABELS.de)).toBe("[ID]");
  });

  test("HTML is converted, only shareable links survive", () => {
    const { r } = setup();
    expect(r.text('<p>Hallo <a href="https://www.example.org/a">Info</a> und <a href="https://x.webuntis.com/y">intern</a></p>')).toBe(
      "Hallo [Info](https://www.example.org/a) und intern",
    );
  });

  test("log URL patterns hide the school host, ids and values", () => {
    expect(redactUrlForLog("https://myschool.webuntis.com/WebUntis/api/rest/view/v1/messages/123?contentAsHtml=true")).toBe(
      "https://<school>.webuntis.com/WebUntis/api/rest/view/v1/messages/{n}?contentAsHtml={v}",
    );
    expect(redactUrlForLog("https://bucket.s3.amazonaws.com/x")).toBe("{storage-url}");
  });
});
