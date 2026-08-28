export type Role = "Center" | "AR" | "Mentor";
export type Bucket = "U8" | "U10" | "U12" | "U14" | "U16" | "U19" | "U99";

export interface RefereeInfo {
  first: string;
  last: string;
  token: string;
}

export interface GameRow {
  gameNum: string | null;
  division: string;
  role: Role;
  date?: Date | null;
}

export type Matrix = Record<Role, Record<Bucket, number>>;

export interface AggResult {
  matrix: Matrix;
  rowTotals: Record<Role, number>;
  colTotals: Record<Bucket, number>;
  grand: number;
  firstDate: Date | null;
  lastDate: Date | null;
}

// ---- Admin referee-list view (refs-admin-regional-by-name) ----

export interface RefereeListRow {
  unid: string | null;
  certification: string | null;
  youth: boolean;
  games: number;
  pending: number;
  done: number;
}

export interface RefereeList {
  rows: RefereeListRow[];
  // Lower-cased header label -> column index (e.g. "certification" -> 18).
  // Used to decide which breakdown sections make sense for this view and to
  // place cells in the appended totals row.
  columns: Map<string, number>;
  // Total number of columns in the list table, including unlabelled spacers.
  columnCount: number;
}

export interface CertCount {
  level: string;
  count: number;
}

export interface RefereeListSummary {
  total: number;
  youth: number;
  adult: number;
  byCertification: CertCount[];
  games: number;
  pending: number;
  done: number;
}
