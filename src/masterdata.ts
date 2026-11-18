/**
 * Master data index: resolves ids to subjects, rooms, classes, teachers, holidays, school years, time grid,
 * excuse statuses (from getUserData2017.masterData, or JSON-RPC for password logins).
 */

import type { MasterData, MdNamed, MdTeacher } from "./api/types";
import type { UntisSession } from "./auth/session";
import { fromUntisDate, hhmm } from "./dates";
import { log } from "./log";

export type Named = { short: string; name?: string };
export type Holiday = { name: string; start: string; end: string };
export type Schoolyear = { id: number; name: string; start: string; end: string };
export type GridUnit = { period: number; label?: string; start: string; end: string };

const named = (x: MdNamed): Named => {
  const short = (x.name ?? "").trim();
  const name = (x.longName ?? "").trim();
  return { short: short || name, ...(name && name !== short ? { name } : {}) };
};

export class MasterIndex {
  readonly subjects = new Map<number, Named>();
  readonly rooms = new Map<number, Named>();
  readonly classes = new Map<number, Named>();
  /** Raw teachers – only for the person registry, never emitted directly. */
  readonly teachers: MdTeacher[] = [];
  readonly holidays: Holiday[] = [];
  readonly schoolyears: Schoolyear[] = [];
  readonly timegrid: GridUnit[] = [];
  readonly excuseStatuses = new Map<number, { name: string; excused?: boolean }>();
  readonly absenceReasons = new Map<number, string>();
  loadedAt = Date.now();

  static fromMasterData(md: MasterData | undefined): MasterIndex {
    const m = new MasterIndex();
    for (const s of md?.subjects ?? []) m.subjects.set(s.id, named(s));
    for (const r of md?.rooms ?? []) m.rooms.set(r.id, named(r));
    for (const k of md?.klassen ?? []) m.classes.set(k.id, named(k));
    m.teachers.push(...(md?.teachers ?? []));
    for (const h of md?.holidays ?? []) {
      if (h.startDate && h.endDate)
        m.holidays.push({ name: (h.longName || h.name || "").trim(), start: h.startDate.slice(0, 10), end: h.endDate.slice(0, 10) });
    }
    for (const y of md?.schoolyears ?? []) {
      if (y.startDate && y.endDate)
        m.schoolyears.push({ id: y.id, name: (y.name ?? "").trim(), start: y.startDate.slice(0, 10), end: y.endDate.slice(0, 10) });
    }
    const day = md?.timeGrid?.days?.find((d) => (d.units?.length ?? 0) > 0);
    (day?.units ?? []).forEach((u, i) => {
      const start = hhmm(u.startTime);
      const end = hhmm(u.endTime);
      if (start && end) m.timegrid.push({ period: i + 1, ...(u.label ? { label: u.label } : {}), start, end });
    });
    for (const e of md?.excuseStatuses ?? []) m.excuseStatuses.set(e.id, { name: (e.longName || e.name || "").trim(), excused: e.excused });
    for (const a of md?.absenceReasons ?? []) m.absenceReasons.set(a.id, (a.longName || a.name || "").trim());
    m.sort();
    return m;
  }

  /** Password logins: the same data from the documented JSON-RPC API (best effort per method). */
  static async fromRpc(session: UntisSession): Promise<MasterIndex> {
    const m = new MasterIndex();
    const safe = async <T>(method: string, params?: unknown): Promise<T | undefined> => {
      try {
        return await session.rpc<T>(method, params ?? {});
      } catch {
        log.warn("Master data not available", { method });
        return undefined;
      }
    };
    type RpcNamed = { id: number; name?: string; longName?: string };
    for (const s of (await safe<RpcNamed[]>("getSubjects")) ?? []) m.subjects.set(s.id, named(s));
    for (const r of (await safe<RpcNamed[]>("getRooms")) ?? []) m.rooms.set(r.id, named(r));
    for (const k of (await safe<RpcNamed[]>("getKlassen")) ?? []) m.classes.set(k.id, named(k));
    const teachers = await safe<{ id: number; name?: string; foreName?: string; longName?: string }[]>("getTeachers");
    for (const t of teachers ?? []) m.teachers.push({ id: t.id, name: t.name, firstName: t.foreName, lastName: t.longName });
    for (const h of (await safe<{ name?: string; longName?: string; startDate?: number; endDate?: number }[]>("getHolidays")) ?? []) {
      const start = fromUntisDate(h.startDate);
      const end = fromUntisDate(h.endDate);
      if (start && end) m.holidays.push({ name: (h.longName || h.name || "").trim(), start, end });
    }
    for (const y of (await safe<{ id: number; name?: string; startDate?: number; endDate?: number }[]>("getSchoolyears")) ?? []) {
      const start = fromUntisDate(y.startDate);
      const end = fromUntisDate(y.endDate);
      if (start && end) m.schoolyears.push({ id: y.id, name: (y.name ?? "").trim(), start, end });
    }
    const grid = await safe<{ day?: number; timeUnits?: { name?: string; startTime?: number; endTime?: number }[] }[]>("getTimegridUnits");
    (grid?.find((d) => (d.timeUnits?.length ?? 0) > 0)?.timeUnits ?? []).forEach((u, i) => {
      const start = hhmm(u.startTime);
      const end = hhmm(u.endTime);
      if (start && end) m.timegrid.push({ period: i + 1, ...(u.name ? { label: u.name } : {}), start, end });
    });
    m.sort();
    return m;
  }

  private sort() {
    this.holidays.sort((a, b) => a.start.localeCompare(b.start));
    this.schoolyears.sort((a, b) => a.start.localeCompare(b.start));
  }

  holidayOn(date: string): Holiday | undefined {
    return this.holidays.find((h) => h.start <= date && date <= h.end);
  }

  schoolyearOn(date: string): Schoolyear | undefined {
    return this.schoolyears.find((y) => y.start <= date && date <= y.end);
  }

  /** Period numbers covered by a lesson ("3" or "3-4"), from the time grid. */
  periodsFor(start?: string, end?: string): string | undefined {
    if (!start || !end || this.timegrid.length === 0) return undefined;
    const covered = this.timegrid.filter((u) => u.start < end && u.end > start).map((u) => u.period);
    if (covered.length === 0) return undefined;
    const first = covered[0]!;
    const last = covered[covered.length - 1]!;
    return first === last ? String(first) : `${first}-${last}`;
  }
}
