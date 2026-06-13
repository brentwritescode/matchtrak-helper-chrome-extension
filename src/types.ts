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
