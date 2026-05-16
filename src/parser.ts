import type { Role, Bucket, RefereeInfo, GameRow, AggResult, Matrix } from "./types";

export const ROLES: readonly Role[] = ["Center", "AR", "Mentor"];
export const BUCKETS: readonly Bucket[] = ["U8", "U10", "U12", "U14", "U16", "U19"];

export function normalizeRole(label: string | null | undefined): Role | null {
  if (!label) return null;
  const s = String(label).trim();
  if (/^center$/i.test(s)) return "Center";
  if (/^assistant$/i.test(s)) return "AR";
  if (/^ar[12]?$/i.test(s)) return "AR";
  if (/^mentor$/i.test(s)) return "Mentor";
  return null;
}

export function bucket(division: string | null | undefined): Bucket | null {
  if (!division) return null;
  // Adult divisions are not tracked; treat them the same as unrecognized values.
  if (/adult/i.test(division)) return null;
  const m = /U(\d+)/i.exec(division);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n <= 8) return "U8";
  if (n <= 10) return "U10";
  if (n <= 12) return "U12";
  if (n <= 14) return "U14";
  if (n <= 16) return "U16";
  if (n <= 19) return "U19";
  // Age groups above U19 are treated as Adult and skipped.
  return null;
}

function cellText(td: Element | null | undefined): string {
  return (td?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function parseDate(s: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (!m) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  const d = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
  return isNaN(d.getTime()) ? null : d;
}

// Extract { first, last, token } for the referee whose profile is being viewed.
// Admin page: <font size="4">Last, First ( Section / Area / Region )</font>
// myref page: a label cell "Last Name" with adjacent value cell, same for "First Name".
export function extractReferee(doc: Document): RefereeInfo | null {
  // 1) Admin "Last, First ( ... )" heading.
  const headings = doc.querySelectorAll('font[size="4"]');
  for (const h of headings) {
    const t = (h.textContent ?? "").trim();
    const m = /^([^,]+),\s*([^()]+?)\s*\(/.exec(t);
    if (m) {
      const last = m[1].trim();
      const first = m[2].trim();
      return { first, last, token: `${last}, ${first}` };
    }
  }

  // 2) Label-keyed lookup for myref page.
  const tds = doc.querySelectorAll("td");
  let firstName: string | null = null;
  let lastName: string | null = null;
  for (let i = 0; i < tds.length; i++) {
    const label = cellText(tds[i]);
    if (label === "First Name" && i + 1 < tds.length) {
      firstName = cellText(tds[i + 1]);
    } else if (label === "Last Name" && i + 1 < tds.length) {
      lastName = cellText(tds[i + 1]);
    }
    if (firstName && lastName) break;
  }
  if (firstName && lastName) {
    return { first: firstName, last: lastName, token: `${lastName}, ${firstName}` };
  }
  return null;
}

// A row qualifies as a "game row" if its first cell starts with a date
// token (either 2- or 4-digit year). Both the active and archived
// sections use the same row shape — the only structural difference is
// where they live (main page vs Expand=N sub-document).
function isGameDate(s: string): boolean {
  return /^\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(s);
}

// Direct children only (not descendants) — avoids counting cells nested
// in inner tables when a wrapper TR contains an entire categorized view.
function directTds(tr: Element): Element[] {
  return Array.from(tr.children).filter((c) => c.tagName === "TD");
}

function findGameRows(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll("tr")).filter((tr) => {
    const tds = directTds(tr);
    if (tds.length < 3) return false;
    return isGameDate(cellText(tds[0]));
  });
}

// Archived game rows: date appears NOT in cell 0 but in a cell whose HTML
// matches "MM/DD/YYYY<br> - DayOfWeek" (a 4-digit year followed by a
// day-of-week suffix). This pattern distinguishes archived game data
// rows from active rows ("MM/DD/YY HH:MM AM<br>FieldName") and from
// category-header rows ("2023 - 9").
const ARCHIVED_DATE_HTML = /\d{1,2}\/\d{1,2}\/\d{4}\s*<br[^>]*>\s*-\s*\w+day/i;

function findArchivedGameRows(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll("tr")).filter((tr) => {
    const tds = directTds(tr);
    if (tds.length < 5) return false;
    return tds.some((td) => ARCHIVED_DATE_HTML.test((td as HTMLElement).innerHTML ?? ""));
  });
}

// A cell text that's just a division token, e.g. "BU10", "GU12", "U14",
// or the string "Adult".
function isDivisionToken(t: string): boolean {
  if (!t) return false;
  if (/^[A-Z]*U\d+$/i.test(t)) return true;
  if (/^adult$/i.test(t)) return true;
  return false;
}

function stripTags(s: string): string {
  return String(s).replace(/<[^>]*>/g, "");
}

// Pull division + position from a row. Handles three shapes:
//   (a) single cell with "BU10<br>Assistant" (legacy admin view)
//   (b) two adjacent cells "BU10" and "Assistant"
//   (c) two non-adjacent cells (myref-profile uses: division at cell 1,
//       role at cell 3, with the game number in between)
export function extractDivisionPositionFromRow(tr: Element): { division: string; role: Role } | null {
  const tds = Array.from(tr.querySelectorAll("td"));

  // Pass 1: look for the single-cell <br>-joined shape.
  for (const td of tds) {
    const html = (td as HTMLElement).innerHTML ?? "";
    const parts = html.split(/<br\s*\/?>/i);
    if (parts.length >= 2) {
      const top = stripTags(parts[0]).trim();
      const bottom = stripTags(parts[1]).trim();
      const role = normalizeRole(bottom);
      if (isDivisionToken(top) && role) {
        return { division: top, role };
      }
    }
  }

  // Pass 2: independent-cell shape. Find the first division-token cell
  // and the first role-token cell anywhere in the row.
  let division: string | null = null;
  let role: Role | null = null;
  for (const td of tds) {
    const t = cellText(td);
    if (!division && isDivisionToken(t)) division = t;
    if (!role) {
      const r = normalizeRole(t);
      if (r) role = r;
    }
  }
  if (division && role) return { division, role };
  return null;
}

// Find the game # in a row (used for dedup). MatchTrak game numbers are
// typically a short numeric or alphanumeric token in a dedicated cell.
// We pick the first cell whose trimmed text matches a digit run of >= 3
// chars and is not a date.
function extractGameNum(tr: Element): string | null {
  for (const td of directTds(tr)) {
    const t = cellText(td);
    if (/^\d{3,}$/.test(t)) return t;
  }
  return null;
}

// Active rows: produce { gameNum, division, role } per row. Skips rows
// where the trailing pending cell is non-empty.
export function parseActiveRows(doc: Document): GameRow[] {
  const out: GameRow[] = [];
  for (const tr of findGameRows(doc)) {
    const tds = directTds(tr);
    const pending = cellText(tds[tds.length - 1]);
    if (pending.length > 0) continue;
    const dp = extractDivisionPositionFromRow(tr);
    if (!dp) continue;
    const date = parseDate(cellText(tds[0]));
    out.push({ gameNum: extractGameNum(tr), division: dp.division, role: dp.role, date });
  }
  return out;
}

// Archived rows: produce { gameNum, division, role } per row. Role is
// resolved by matching refToken ("Last, First") against the crew cell
// which contains "<br>"-separated lines like
// "Center: R1455-Nash, Brent (REG)" / "AR1: ..." / "AR2: ..." / "Mentor: ...".
export function parseArchivedRows(doc: Document, refToken: string): GameRow[] {
  const out: GameRow[] = [];
  for (const tr of findArchivedGameRows(doc)) {
    const tds = directTds(tr);

    // Division: cell whose first <br>-split chunk is a U-token (e.g. "BU10<br>Flight: 1" -> "BU10").
    let division: string | null = null;
    for (const td of tds) {
      const html = (td as HTMLElement).innerHTML ?? "";
      const firstChunk = stripTags(html.split(/<br\s*\/?>/i)[0]).trim();
      if (/^[A-Z]*U\d+/i.test(firstChunk)) {
        division = firstChunk;
        break;
      }
    }
    if (!division) continue;

    // Game number: cell whose plain text is a 3+ digit number.
    let gameNum: string | null = null;
    for (const td of tds) {
      const t = cellText(td);
      if (/^\d{3,}$/.test(t)) {
        gameNum = t;
        break;
      }
    }

    // Crew cell: the one containing refToken AND a role marker.
    let role: Role | null = null;
    for (const td of tds) {
      const html = (td as HTMLElement).innerHTML ?? "";
      if (!html.includes(refToken)) continue;
      const lines = html
        .split(/<br\s*\/?>/i)
        .map(stripTags)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const line of lines) {
        if (!line.includes(refToken)) continue;
        const m = /^(Center|AR1|AR2|Mentor)\s*:/i.exec(line);
        if (m) {
          role = normalizeRole(m[1]);
          break;
        }
      }
      if (role) break;
    }
    if (!role) continue;

    let date: Date | null = null;
    for (const td of tds) {
      const html = (td as HTMLElement).innerHTML ?? "";
      if (ARCHIVED_DATE_HTML.test(html)) {
        date = parseDate(stripTags(html.split(/<br\s*\/?>/i)[0]).trim());
        break;
      }
    }

    out.push({ gameNum, division, role, date });
  }
  return out;
}

// Build a 3x6 matrix of counts plus totals.
export function aggregate(games: GameRow[]): AggResult {
  const matrix = {} as Matrix;
  for (const r of ROLES) {
    matrix[r] = {} as Record<Bucket, number>;
    for (const b of BUCKETS) matrix[r][b] = 0;
  }
  let firstDate: Date | null = null;
  let lastDate: Date | null = null;
  for (const g of games) {
    if (!g?.role || !ROLES.includes(g.role)) continue;
    if (g.date) {
      if (!firstDate || g.date < firstDate) firstDate = g.date;
      if (!lastDate || g.date > lastDate) lastDate = g.date;
    }
    const b = bucket(g.division);
    if (!b) continue;
    matrix[g.role][b] += 1;
  }
  const rowTotals = {} as Record<Role, number>;
  const colTotals = {} as Record<Bucket, number>;
  for (const b of BUCKETS) colTotals[b] = 0;
  let grand = 0;
  for (const r of ROLES) {
    rowTotals[r] = 0;
    for (const b of BUCKETS) {
      rowTotals[r] += matrix[r][b];
      colTotals[b] += matrix[r][b];
      grand += matrix[r][b];
    }
  }
  return { matrix, rowTotals, colTotals, grand, firstDate, lastDate };
}

// Dedup an array of games by gameNum (rows without a gameNum are kept).
export function dedupByGameNum(games: GameRow[]): GameRow[] {
  const seen = new Set<string>();
  const out: GameRow[] = [];
  for (const g of games) {
    if (g.gameNum) {
      if (seen.has(g.gameNum)) continue;
      seen.add(g.gameNum);
    }
    out.push(g);
  }
  return out;
}
