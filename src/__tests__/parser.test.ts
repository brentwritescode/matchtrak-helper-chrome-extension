import {
  normalizeRole,
  bucket,
  extractReferee,
  parseActiveRows,
  parseArchivedRows,
  aggregate,
  dedupByGameNum,
  extractDivisionPositionFromRow,
  canonicalProfileUrl,
  countRefereeRows,
  parseRefereeList,
  summarizeRefereeList,
  ROLES,
  BUCKETS,
} from "../parser";
import type { GameRow, RefereeListRow } from "../types";

// ---------- normalizeRole ----------

describe("normalizeRole", () => {
  it.each([
    ["center", "Center"],
    ["Center", "Center"],
    ["CENTER", "Center"],
    ["assistant", "AR"],
    ["Assistant", "AR"],
    ["AR", "AR"],
    ["AR1", "AR"],
    ["AR2", "AR"],
    ["ar", "AR"],
    ["mentor", "Mentor"],
    ["Mentor", "Mentor"],
    ["MENTOR", "Mentor"],
  ] as const)('normalizes "%s" → "%s"', (input, expected) => {
    expect(normalizeRole(input)).toBe(expected);
  });

  it.each([null, undefined, "", "Linesman", "4th Official", "  "])(
    'returns null for %s',
    (input) => {
      expect(normalizeRole(input)).toBeNull();
    }
  );
});

// ---------- bucket ----------

describe("bucket", () => {
  it.each([
    ["U8", "U8"],
    ["BU8", "U8"],
    ["GU8", "U8"],
    ["U6", "U8"],   // ≤8 rounds up to U8
    ["U7", "U8"],
    ["BU10", "U10"],
    ["U10", "U10"],
    ["U9", "U10"],  // between 8 and 10
    ["GU12", "U12"],
    ["BU14", "U14"],
    ["U13", "U14"],
    ["U16", "U16"],
    ["U15", "U16"],
    ["BU19", "U19"],
    ["U17", "U19"],
    ["U18", "U19"],
    ["U99", "U99"],
  ] as const)('maps "%s" → "%s"', (input, expected) => {
    expect(bucket(input)).toBe(expected);
  });

  it.each([null, undefined, "", "Adult", "adult", "U20", "Senior", "Open"])(
    'returns null for %s',
    (input) => {
      expect(bucket(input)).toBeNull();
    }
  );
});

// ---------- helpers ----------

function makeDoc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function makeRow(html: string): Element {
  const doc = makeDoc(`<table><tbody><tr>${html}</tr></tbody></table>`);
  return doc.querySelector("tr")!;
}

// ---------- extractReferee ----------

describe("extractReferee", () => {
  it("extracts from admin page format (Last, First ( ... ))", () => {
    const doc = makeDoc(`
      <html><body>
        <font size="4">Doe, John ( Northern California / Bay Area )</font>
      </body></html>
    `);
    expect(extractReferee(doc)).toEqual({
      first: "John",
      last: "Doe",
      token: "Doe, John",
    });
  });

  it("extracts from myref label-cell format", () => {
    const doc = makeDoc(`
      <html><body>
        <table>
          <tr><td>First Name</td><td>Jane</td></tr>
          <tr><td>Last Name</td><td>Doe</td></tr>
        </table>
      </body></html>
    `);
    expect(extractReferee(doc)).toEqual({
      first: "Jane",
      last: "Doe",
      token: "Doe, Jane",
    });
  });

  it("returns null when no referee info is present", () => {
    expect(extractReferee(makeDoc("<html><body><p>Nothing here</p></body></html>"))).toBeNull();
  });

  it("ignores admin headings with no comma-paren pattern", () => {
    const doc = makeDoc(`<html><body><font size="4">Just a heading</font></body></html>`);
    expect(extractReferee(doc)).toBeNull();
  });
});

// ---------- extractDivisionPositionFromRow ----------

describe("extractDivisionPositionFromRow", () => {
  it("handles single-cell <br>-joined shape", () => {
    const tr = makeRow("<td>Date</td><td>BU10<br>Center</td><td>12345</td><td>Teams</td><td></td>");
    expect(extractDivisionPositionFromRow(tr)).toEqual({ division: "BU10", role: "Center" });
  });

  it("handles two-cell shape", () => {
    const tr = makeRow("<td>Date</td><td>GU12</td><td>Assistant</td><td>Teams</td><td></td>");
    expect(extractDivisionPositionFromRow(tr)).toEqual({ division: "GU12", role: "AR" });
  });

  it("returns null when no role found", () => {
    const tr = makeRow("<td>Date</td><td>BU10</td><td>Teams</td><td></td>");
    expect(extractDivisionPositionFromRow(tr)).toBeNull();
  });
});

// ---------- aggregate ----------

describe("aggregate", () => {
  it("initializes all matrix cells to 0", () => {
    const agg = aggregate([]);
    expect(agg.grand).toBe(0);
    for (const r of ROLES) {
      expect(agg.rowTotals[r]).toBe(0);
      for (const b of BUCKETS) {
        expect(agg.matrix[r][b]).toBe(0);
      }
    }
    for (const b of BUCKETS) {
      expect(agg.colTotals[b]).toBe(0);
    }
  });

  it("counts games by role and bucket correctly", () => {
    const games: GameRow[] = [
      { gameNum: "100", division: "BU10", role: "Center" },
      { gameNum: "101", division: "GU12", role: "AR" },
      { gameNum: "102", division: "BU10", role: "Center" },
      { gameNum: "103", division: "U14", role: "Mentor" },
    ];
    const agg = aggregate(games);
    expect(agg.matrix["Center"]["U10"]).toBe(2);
    expect(agg.matrix["AR"]["U12"]).toBe(1);
    expect(agg.matrix["Mentor"]["U14"]).toBe(1);
    expect(agg.rowTotals["Center"]).toBe(2);
    expect(agg.rowTotals["AR"]).toBe(1);
    expect(agg.colTotals["U10"]).toBe(2);
    expect(agg.colTotals["U12"]).toBe(1);
    expect(agg.grand).toBe(4);
  });

  it("ignores games with Adult or unknown divisions", () => {
    const games: GameRow[] = [
      { gameNum: "1", division: "Adult", role: "Center" },
      { gameNum: "2", division: "U20", role: "AR" },
      { gameNum: "3", division: "Open", role: "Mentor" },
    ];
    expect(aggregate(games).grand).toBe(0);
  });

  it("counts U99 games in the U99 bucket", () => {
    const games: GameRow[] = [
      { gameNum: "1", division: "U99", role: "Center" },
      { gameNum: "2", division: "BU99", role: "AR" },
    ];
    const agg = aggregate(games);
    expect(agg.matrix["Center"]["U99"]).toBe(1);
    expect(agg.matrix["AR"]["U99"]).toBe(1);
    expect(agg.colTotals["U99"]).toBe(2);
    expect(agg.grand).toBe(2);
  });

  it("returns null firstDate and lastDate when no games have dates", () => {
    const games: GameRow[] = [
      { gameNum: "1", division: "BU10", role: "Center" },
      { gameNum: "2", division: "GU12", role: "AR" },
    ];
    const agg = aggregate(games);
    expect(agg.firstDate).toBeNull();
    expect(agg.lastDate).toBeNull();
  });

  it("tracks firstDate and lastDate across a mix of games", () => {
    const oldest = new Date(2022, 0, 15);
    const middle = new Date(2024, 4, 10);
    const newest = new Date(2026, 1, 28);
    const games: GameRow[] = [
      { gameNum: "1", division: "BU10", role: "Center", date: middle },
      { gameNum: "2", division: "GU12", role: "AR", date: oldest },
      { gameNum: "3", division: "U14", role: "Center", date: newest },
    ];
    const agg = aggregate(games);
    expect(agg.firstDate).toEqual(oldest);
    expect(agg.lastDate).toEqual(newest);
  });

  it("archived date (older) wins over active date as firstDate", () => {
    // Simulates the core scenario: active game is 2/28/2026, archived game is older.
    // Both have proper Date objects (as readCache now rehydrates them).
    const activeDate = new Date(2026, 1, 28);
    const archivedDate = new Date(2022, 0, 15);
    const games: GameRow[] = [
      { gameNum: "active-1", division: "BU10", role: "Center", date: activeDate },
      { gameNum: "archived-1", division: "GU12", role: "AR", date: archivedDate },
    ];
    const agg = aggregate(games);
    expect(agg.firstDate).toEqual(archivedDate);
    expect(agg.lastDate).toEqual(activeDate);
  });

  it("handles a single game with a date", () => {
    const d = new Date(2024, 5, 1);
    const games: GameRow[] = [{ gameNum: "1", division: "BU10", role: "Center", date: d }];
    const agg = aggregate(games);
    expect(agg.firstDate).toEqual(d);
    expect(agg.lastDate).toEqual(d);
  });

  it("ignores null dates when other games have valid dates", () => {
    const d = new Date(2024, 5, 1);
    const games: GameRow[] = [
      { gameNum: "1", division: "BU10", role: "Center", date: d },
      { gameNum: "2", division: "GU12", role: "AR", date: null },
    ];
    const agg = aggregate(games);
    expect(agg.firstDate).toEqual(d);
    expect(agg.lastDate).toEqual(d);
  });
});

// ---------- dedupByGameNum ----------

describe("dedupByGameNum", () => {
  it("keeps rows that reuse a game number for different games", () => {
    const games: GameRow[] = [
      { gameNum: "100", division: "BU10", role: "Center", date: new Date(2013, 8, 14) },
      { gameNum: "101", division: "GU12", role: "AR" },
      { gameNum: "100", division: "BU14", role: "Mentor", date: new Date(2017, 4, 13) },
    ];
    const result = dedupByGameNum(games);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("Center");
    expect(result[1].role).toBe("AR");
    expect(result[2].role).toBe("Mentor");
  });

  it("removes exact duplicate game rows, keeping first occurrence", () => {
    const date = new Date(2024, 3, 18);
    const games: GameRow[] = [
      { gameNum: "27733", division: "U99", role: "AR", date },
      { gameNum: "27734", division: "U99", role: "Center", date: new Date(2024, 3, 25) },
      { gameNum: "27733", division: "U99", role: "AR", date },
    ];
    const result = dedupByGameNum(games);
    expect(result).toHaveLength(2);
    expect(result[0].gameNum).toBe("27733");
    expect(result[1].gameNum).toBe("27734");
  });

  it("keeps all rows with null gameNum", () => {
    const games: GameRow[] = [
      { gameNum: null, division: "BU10", role: "Center" },
      { gameNum: null, division: "GU12", role: "AR" },
    ];
    expect(dedupByGameNum(games)).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(dedupByGameNum([])).toEqual([]);
  });
});

// ---------- parseActiveRows ----------

describe("parseActiveRows", () => {
  it("parses a well-formed active row", () => {
    const doc = makeDoc(`
      <html><body><table>
        <tr>
          <td>05/10/24 10:00 AM</td>
          <td>BU10<br>Center</td>
          <td>12345</td>
          <td>Team A vs Team B</td>
          <td></td>
        </tr>
      </table></body></html>
    `);
    const rows = parseActiveRows(doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ gameNum: "12345", division: "BU10", role: "Center", date: new Date(2024, 4, 10) });
  });

  it("skips rows where the pending cell is non-empty", () => {
    const doc = makeDoc(`
      <html><body><table>
        <tr>
          <td>05/10/24 10:00 AM</td>
          <td>BU10<br>Center</td>
          <td>12345</td>
          <td>Team A vs Team B</td>
          <td>Pending</td>
        </tr>
      </table></body></html>
    `);
    expect(parseActiveRows(doc)).toHaveLength(0);
  });

  it("skips rows with fewer than 3 cells", () => {
    const doc = makeDoc(`
      <html><body><table>
        <tr><td>05/10/24</td><td>BU10<br>Center</td></tr>
      </table></body></html>
    `);
    expect(parseActiveRows(doc)).toHaveLength(0);
  });

  it("returns empty array for a page with no game rows", () => {
    expect(parseActiveRows(makeDoc("<html><body><p>No data</p></body></html>"))).toHaveLength(0);
  });

  it("parses multiple rows", () => {
    const doc = makeDoc(`
      <html><body><table>
        <tr>
          <td>05/10/24 10:00 AM</td><td>BU10<br>Center</td><td>10001</td><td>A vs B</td><td></td>
        </tr>
        <tr>
          <td>05/11/24 12:00 PM</td><td>GU12<br>AR1</td><td>10002</td><td>C vs D</td><td></td>
        </tr>
      </table></body></html>
    `);
    const rows = parseActiveRows(doc);
    expect(rows).toHaveLength(2);
    expect(rows[1].role).toBe("AR");
  });
});

// ---------- parseArchivedRows ----------

describe("parseArchivedRows", () => {
  function archivedDoc(crewHtml: string, division = "BU12", gameNum = "67890") {
    return makeDoc(`
      <html><body><table><tr>
        <td>spacer</td>
        <td>spacer</td>
        <td>spacer</td>
        <td>05/10/2024<br>- Saturday</td>
        <td>${division}<br>Flight: 1</td>
        <td>${gameNum}</td>
        <td>Team X vs Team Y</td>
        <td>${crewHtml}</td>
        <td>Park Field</td>
      </tr></table></body></html>
    `);
  }

  it("extracts a Center role from the crew cell", () => {
    const doc = archivedDoc("Center: Doe, John (REG)<br>AR1: Smith, John (REG)");
    const rows = parseArchivedRows(doc, "Doe, John");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      gameNum: "67890",
      division: "BU12",
      role: "Center",
      date: new Date(2024, 4, 10),
    });
  });

  it("extracts an AR role from the crew cell", () => {
    const doc = archivedDoc("Center: Jones, Bob (REG)<br>AR1: Doe, John (REG)");
    const rows = parseArchivedRows(doc, "Doe, John");
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("AR");
  });

  it("skips rows where refToken is not in crew", () => {
    const doc = archivedDoc("Center: Jones, Bob (REG)<br>AR1: Smith, John (REG)");
    expect(parseArchivedRows(doc, "Doe, John")).toHaveLength(0);
  });

  it("returns empty array for pages with no archived rows", () => {
    expect(parseArchivedRows(makeDoc("<html><body></body></html>"), "Doe, John")).toHaveLength(0);
  });
});

// ---------- canonicalProfileUrl ----------

describe("canonicalProfileUrl", () => {
  it("swaps a league-season subdomain to the canonical host, preserving path + query", () => {
    expect(
      canonicalProfileUrl(
        "https://s11l889-26-spring.matchtrak.com/11/referee.nsf/open/98BBBA7AB7F2469F8825801D00788604?opendocument"
      )
    ).toBe(
      "https://www.matchtrak.com/11/referee.nsf/open/98BBBA7AB7F2469F8825801D00788604?opendocument"
    );
  });

  it("preserves the open-myref-profile view type", () => {
    expect(
      canonicalProfileUrl(
        "https://s11l889-26-spring.matchtrak.com/11/referee.nsf/open-myref-profile/ABC123?opendocument"
      )
    ).toBe("https://www.matchtrak.com/11/referee.nsf/open-myref-profile/ABC123?opendocument");
  });

  it("returns null when already on the canonical host", () => {
    expect(
      canonicalProfileUrl(
        "https://www.matchtrak.com/11/referee.nsf/open/ABC123?opendocument"
      )
    ).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(canonicalProfileUrl("not a url")).toBeNull();
  });
});

// ---------- countRefereeRows ----------

describe("countRefereeRows", () => {
  // Mirrors the real admin-list markup: an unquoted action-icon link per row.
  const row = (unid: string) =>
    `<tr valign="top"><td>` +
    `<a href=/11/referee.nsf/open/${unid}?opendocument><img src=/icons/actn029.gif></a>` +
    `</td><td><font size="2" color="#0000ff" face="Calibri">Referee ${unid}</font></td></tr>`;

  function listDoc(unids: string[], extra = ""): Document {
    return makeDoc(
      `<html><body><table>${unids.map(row).join("")}</table>${extra}</body></html>`
    );
  }

  it("counts one per distinct referee profile link", () => {
    const doc = listDoc([
      "0BA1B9050064390C88258CF2007A1461",
      "C66D9355D0CEB85388258CF10052E833",
      "99D56D686581BC6B88258ADF0056AC61",
    ]);
    expect(countRefereeRows(doc)).toBe(3);
  });

  it("returns 0 when the page has no referee profile links", () => {
    const doc = makeDoc(`
      <html><body>
        <a href="/11/referee.nsf/refs-admin-regional-by-name?openview&count=500">by Referee</a>
        <a href="/11/referee.nsf/ref?openform">New Referee</a>
        <a href="">next</a>
      </body></html>
    `);
    expect(countRefereeRows(doc)).toBe(0);
  });

  it("de-dupes a UNID that appears more than once, case-insensitively", () => {
    const doc = listDoc([
      "ABC123ABC123ABC123ABC123ABC12345",
      "abc123abc123abc123abc123abc12345",
      "DEF456DEF456DEF456DEF456DEF45678",
    ]);
    expect(countRefereeRows(doc)).toBe(2);
  });

  it("ignores view links and the expand/collapse pager", () => {
    const doc = listDoc(["1234ABCD1234ABCD1234ABCD1234ABCD"], `
      <a href="/11/referee.nsf/refs-admin-regional-by-name?OpenView&Count=500&ExpandView&RestrictToCategory=R1455">expand</a>
      <a href="/11/referee.nsf/refs-admin-regional-by-name?OpenView&Count=500&CollapseView">collapse</a>
      <a href="" onclick="return _doClick('88257C7C007909CD.abcdef', this, null)">next</a>
    `);
    expect(countRefereeRows(doc)).toBe(1);
  });
});

// ---------- parseRefereeList / summarizeRefereeList ----------

function adminListDoc(
  refs: Array<{
    unid: string;
    cert?: string;
    youth?: boolean;
    games?: number;
    pending?: number;
    done?: number;
  }>
): Document {
  // Header with unlabelled spacer <th> cells between real columns, mirroring
  // the real Domino view so column-by-label mapping is exercised.
  const header =
    `<tr><th>Open<br><hr></th><th></th>` +
    `<th>Referee<br><hr></th><th></th>` +
    `<th>Certification<br><hr></th><th></th>` +
    `<th>Youth<br><hr></th><th></th>` +
    `<th>Games <br><hr></th><th>Pending <br><hr></th><th>Done <br><hr></th></tr>`;
  const body = refs
    .map(
      (r) =>
        `<tr valign="top">` +
        `<td><a href=/11/referee.nsf/open/${r.unid}?opendocument><img></a></td><td></td>` +
        `<td><font size="2" color="#0000ff">Ref ${r.unid}</font></td><td></td>` +
        `<td>${r.cert ?? ""}</td><td></td>` +
        `<td>${r.youth ? "Yes" : ""}</td><td></td>` +
        `<td>${r.games ?? 0}</td><td>${r.pending ?? 0}</td><td>${r.done ?? 0}</td>` +
        `</tr>`
    )
    .join("");
  return makeDoc(`<html><body><table>${header}${body}</table></body></html>`);
}

describe("parseRefereeList", () => {
  it("reads certification, youth, and assignment columns by header label", () => {
    const doc = adminListDoc([
      { unid: "a1", cert: "Regional", youth: true, games: 3, pending: 2, done: 1 },
      { unid: "b2", cert: "National", youth: false, games: 5, pending: 0, done: 5 },
    ]);
    const { rows, columns, columnCount } = parseRefereeList(doc);
    expect(rows).toEqual([
      { unid: "A1", certification: "Regional", youth: true, games: 3, pending: 2, done: 1 },
      { unid: "B2", certification: "National", youth: false, games: 5, pending: 0, done: 5 },
    ]);
    expect(columns.get("certification")).toBe(4);
    expect(columns.get("youth")).toBe(6);
    expect(columns.get("games")).toBe(8);
    expect(columnCount).toBe(11);
  });

  it("treats a blank Youth cell as adult and blank Certification as null", () => {
    const doc = adminListDoc([{ unid: "c3" }]);
    expect(parseRefereeList(doc).rows[0]).toEqual({
      unid: "C3",
      certification: null,
      youth: false,
      games: 0,
      pending: 0,
      done: 0,
    });
  });

  it("ignores the layout <tr> wrappers the list table is nested in", () => {
    // MatchTrak nests the list table inside <table><tr><td>…</td></tr>. Those
    // wrapper rows contain every profile link as a descendant; a naive scan
    // would treat the first as a single-cell referee row and, via UNID de-dup,
    // drop the real first referee.
    const inner = adminListDoc([
      { unid: "a1", cert: "Regional", youth: false, games: 1, pending: 1, done: 0 },
      { unid: "b2", cert: "National", youth: true, games: 2, pending: 0, done: 2 },
    ]).querySelector("table")!.outerHTML;
    const doc = makeDoc(
      `<html><body><table width="100%"><tr valign="top"><td>${inner}</td></tr></table></body></html>`
    );
    const { rows } = parseRefereeList(doc);
    expect(rows).toEqual([
      { unid: "A1", certification: "Regional", youth: false, games: 1, pending: 1, done: 0 },
      { unid: "B2", certification: "National", youth: true, games: 2, pending: 0, done: 2 },
    ]);
  });

  it("still returns rows (with no columns) when there is no header row", () => {
    const doc = makeDoc(
      `<html><body><table><tr><td>` +
        `<a href=/11/referee.nsf/open/d4?opendocument><img></a></td></tr></table></body></html>`
    );
    const { rows, columns, columnCount } = parseRefereeList(doc);
    expect(rows).toHaveLength(1);
    expect(columns.size).toBe(0);
    expect(columnCount).toBe(0);
    expect(rows[0].certification).toBeNull();
  });
});

describe("summarizeRefereeList", () => {
  const mk = (o: Partial<RefereeListRow>): RefereeListRow => ({
    unid: null,
    certification: null,
    youth: false,
    games: 0,
    pending: 0,
    done: 0,
    ...o,
  });

  it("splits youth vs adult and totals the assignment columns", () => {
    const s = summarizeRefereeList([
      mk({ youth: true, games: 2, pending: 1, done: 1 }),
      mk({ youth: false, games: 3, pending: 0, done: 3 }),
      mk({ youth: false, games: 5, pending: 5, done: 0 }),
    ]);
    expect(s.total).toBe(3);
    expect(s.youth).toBe(1);
    expect(s.adult).toBe(2);
    expect(s.games).toBe(10);
    expect(s.pending).toBe(6);
    expect(s.done).toBe(4);
  });

  it("counts certification levels dynamically, ordering known levels by progression", () => {
    const s = summarizeRefereeList([
      mk({ certification: "National" }),
      mk({ certification: "Regional" }),
      mk({ certification: "Regional" }),
      mk({ certification: "Advanced" }),
      mk({ certification: "8U" }), // unfamiliar level from another region
    ]);
    expect(s.byCertification).toEqual([
      { level: "Regional", count: 2 },
      { level: "Advanced", count: 1 },
      { level: "National", count: 1 },
      { level: "8U", count: 1 },
    ]);
  });

  it("labels referees with no certification as 'Unspecified', sorted after known levels", () => {
    const s = summarizeRefereeList([mk({}), mk({ certification: "Regional" })]);
    expect(s.byCertification).toEqual([
      { level: "Regional", count: 1 },
      { level: "Unspecified", count: 1 },
    ]);
  });
});
