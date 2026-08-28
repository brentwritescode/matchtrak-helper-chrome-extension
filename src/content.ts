import {
  ROLES,
  BUCKETS,
  extractReferee,
  parseActiveRows,
  parseArchivedRows,
  aggregate,
  dedupByGameNum,
  canonicalProfileUrl,
  parseRefereeList,
  summarizeRefereeList,
} from "./parser";
import type { GameRow, AggResult, RefereeListSummary } from "./types";

const TAG = "[MTHelper]";
const ROOT_ID = "mthelper-root";
const STATS_ROOT_ID = "mthelper-refstats-root";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const CONCURRENCY = 15;

if (!document.getElementById(ROOT_ID) && !document.getElementById(STATS_ROOT_ID)) {
  if (isAdminRefListPage()) {
    injectRefereeStats();
  } else {
    main();
  }
}

function main(): void {
  const ref = extractReferee(document);
  if (!ref) {
    console.warn(TAG, "could not identify referee on this page");
    return;
  }
  const refToken = ref.token;

  const insertion = findInsertionPoint();
  if (!insertion) {
    console.warn(TAG, "could not find insertion point");
    return;
  }

  const section = document.createElement("section");
  section.id = ROOT_ID;
  section.className = "mthelper-stats";
  section.innerHTML = renderShell();

  if ("before" in insertion) {
    insertion.before.parentNode!.insertBefore(section, insertion.before);
  } else {
    insertion.after.parentNode!.insertBefore(section, insertion.after.nextSibling);
  }

  // On a league-season subdomain, these counts only cover that instance's
  // partial archive. Point the referee at their full regional history on the
  // main site (same profile, hostname swapped) — no fetch, no extra permissions.
  const sourceEl = section.querySelector<HTMLElement>(".mthelper-source");
  const canonicalUrl = canonicalProfileUrl(location.href);
  if (sourceEl && canonicalUrl) {
    sourceEl.innerHTML =
      `These counts reflect games recorded in this league/season instance ` +
      `(<a href="${escapeHtml(location.origin)}">${escapeHtml(location.hostname)}</a>) ` +
      `and may not capture this referee's entire game history. ` +
      `<a href="${escapeHtml(canonicalUrl)}">Click Here</a> to view the full history on www.matchtrak.com ` +
      `(you may be asked to log in again).`;
    // The note is a block sibling, so it would stretch to the page width.
    // Pin its max-width to the stats table's rendered width (which depends on
    // its data and changes loading→loaded) so the text wraps under the table.
    const statsTable = section.querySelector<HTMLElement>(".mthelper-stats-table");
    if (statsTable && typeof ResizeObserver !== "undefined") {
      const sync = () => {
        sourceEl.style.maxWidth = `${statsTable.offsetWidth}px`;
      };
      sync();
      new ResizeObserver(sync).observe(statsTable);
    }
  }

  let activeRows: GameRow[] = [];
  try {
    activeRows = parseActiveRows(document);
  } catch (err) {
    console.warn(TAG, "active parse failed", err);
  }

  let expandLinks = collectExpandLinks(document);

  const refreshBtn = section.querySelector<HTMLButtonElement>(".mthelper-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refreshBtn.disabled = true;
      loadData(true);
    });
  }

  updateTable(activeRows, [], true, 0);
  loadData(false);

  function updateTable(
    active: GameRow[],
    archived: GameRow[],
    loading: boolean,
    errors: number,
    settledCount = 0,
    totalCount = 0
  ): void {
    const raw = [...active, ...archived];
    const all = dedupByGameNum(raw);
    const duplicatesRemoved = raw.length - all.length;
    const agg = aggregate(all);
    const tbody = section.querySelector("tbody.mthelper-body");
    if (!tbody) return;
    tbody.innerHTML = renderBody(agg);

    const infoContainer = section.querySelector(".mthelper-info-table-container");
    if (infoContainer) infoContainer.innerHTML = renderInfoTable(agg, loading && archived.length === 0);

    const note = section.querySelector(".mthelper-note");
    if (note) {
      const parts: string[] = [
        `Active: ${active.length}`,
        `Archived: ${archived.length}`,
        `Total: ${agg.grand}${duplicatesRemoved > 0 ? ` (Ignored Duplicates: ${duplicatesRemoved})` : ""}`,
      ];
      if (loading && totalCount > 0) parts.push(`loading ${settledCount}/${totalCount} months…`);
      if (errors > 0) parts.push(`${errors} fetch error(s)`);
      note.textContent = parts.join(" · ");
    }

    const indicator = section.querySelector<HTMLElement>(".mthelper-loading-indicator");
    if (indicator) indicator.style.display = loading ? "flex" : "none";

    const warning = section.querySelector<HTMLElement>(".mthelper-warning");
    if (warning) {
      if (!loading && errors > 0) {
        warning.textContent = "Error encountered — data may be incomplete. Press Refresh to try again.";
        warning.style.display = "block";
      } else {
        warning.style.display = "none";
      }
    }

    if (!loading) {
      const btn = section.querySelector<HTMLButtonElement>(".mthelper-refresh");
      if (btn) btn.disabled = false;
    }
  }

  async function loadData(force: boolean): Promise<void> {
    const archivedRows: GameRow[] = [];
    let errors = 0;
    let settled = 0;

    // On a forced refresh, re-fetch the current page so that activeRows and
    // expandLinks reflect any assignments or new seasons added since first load.
    if (force) {
      updateTable(activeRows, [], true, 0);
      try {
        const html = await fetchWithRetry(location.href);
        const freshDoc = new DOMParser().parseFromString(html, "text/html");
        try {
          activeRows = parseActiveRows(freshDoc);
        } catch (err) {
          console.warn(TAG, "active parse failed on refresh", err);
        }
        // Capture any archived tabs already expanded inline on the refreshed page.
        try {
          const rows = parseArchivedRows(freshDoc, refToken);
          for (const r of rows) archivedRows.push(r);
        } catch (err) {
          console.warn(TAG, "inline archived parse failed on refresh", err);
        }
        expandLinks = collectExpandLinks(freshDoc);
      } catch {
        errors += 1;
      }
    } else {
      // Capture any archived tabs already expanded inline on the current page.
      try {
        const rows = parseArchivedRows(document, refToken);
        for (const r of rows) archivedRows.push(r);
      } catch (err) {
        console.warn(TAG, "inline archived parse failed", err);
      }
    }

    const total = expandLinks.length;

    if (total === 0) {
      updateTable(activeRows, [], false, errors);
      return;
    }

    updateTable(activeRows, [], true, errors, 0, total);

    const queue = [...expandLinks];

    function processNext(): void {
      const url = queue.shift();
      if (url === undefined) return;

      if (force) clearCache(url, refToken);
      const cached$ = force ? Promise.resolve<GameRow[] | null>(null) : readCache(url, refToken);

      cached$
        .then((cached) => {
          if (cached) {
            for (const r of cached) archivedRows.push(r);
            return;
          }
          return fetchWithRetry(url)
            .then((html) => {
              const sub = new DOMParser().parseFromString(html, "text/html");
              const rows = parseArchivedRows(sub, refToken);
              writeCache(url, refToken, rows);
              for (const r of rows) archivedRows.push(r);
            });
        })
        .catch(() => {
          errors += 1;
        })
        .finally(() => {
          settled += 1;
          updateTable(activeRows, archivedRows, settled !== total, errors, settled, total);
          processNext();
        });
    }

    const workers = Math.min(CONCURRENCY, total);
    for (let i = 0; i < workers; i++) {
      processNext();
    }
  }
}

// ---------- helpers ----------

// The "Referee Profile - Administration" list (Referees > Admin - Regional >
// by Name, plus its compliance sub-views). This is an admin's working list of
// active referees, so surface some at-a-glance stats.
function isAdminRefListPage(): boolean {
  return /\/referee\.nsf\/refs-admin-regional-by-name/i.test(
    location.pathname + location.search
  );
}

function injectRefereeStats(): void {
  const { rows, columns, columnCount } = parseRefereeList(document);
  if (rows.length === 0) {
    console.warn(TAG, "referee list: no referee rows found — nothing to summarise");
    return;
  }

  const table = findRefereeListTable();
  if (!table || !table.parentNode) {
    console.warn(TAG, "referee list: could not find the list table");
    return;
  }

  const summary = summarizeRefereeList(rows);

  // Breakdown panel above the list.
  const section = document.createElement("section");
  section.id = STATS_ROOT_ID;
  section.className = "mthelper-refstats";
  section.innerHTML = renderRefereeBreakdown(summary, columns);
  table.parentNode.insertBefore(section, table);

  // MatchTrak's stylesheet forces every table to full page width; an inline
  // width overrides it. The panel wants to be as wide as its content, but no
  // wider than the list — past that, the chip row wraps.
  const panel = section.querySelector<HTMLElement>(".mthelper-refstats-table");
  const listTable = table as HTMLElement;
  if (panel) {
    panel.style.width = "max-content";
    if (typeof ResizeObserver !== "undefined") {
      const sync = () => {
        panel.style.maxWidth = `${listTable.offsetWidth}px`;
      };
      sync();
      new ResizeObserver(sync).observe(listTable);
    }
  }

  // Games / Pending / Done totals belong with the columns they sum — a bold
  // "Total" row appended to the list table itself.
  appendListTotalRow(table, columns, columnCount, summary);

  console.log(TAG, `referee list: ${summary.total} referee(s) on this page`);
}

// The list table is the one holding the per-referee profile links. Walk up
// from the first such link to its nearest enclosing <table>.
function findRefereeListTable(): Element | null {
  const link = document.querySelector<HTMLAnchorElement>(
    'a[href*="referee.nsf/open/"][href*="opendocument"]'
  );
  let n: Element | null = link;
  while (n && n.tagName !== "TABLE") n = n.parentElement;
  return n;
}

// Compact "type" + "certification" breakdown shown above the list, laid out
// horizontally: one row per grouping, its counts as inline chips. The "By cert"
// row is only added when the view carries that column.
function renderRefereeBreakdown(s: RefereeListSummary, columns: Map<string, number>): string {
  const chip = (label: string, value: number) =>
    `<span class="mthelper-refstats-chip">${escapeHtml(label)}&nbsp;<b>${value}</b></span>`;
  const groupRow = (label: string, chips: string[]) =>
    `<tr><td class="mthelper-refstats-label">${escapeHtml(label)}</td>` +
    `<td class="mthelper-refstats-chips">${chips.join("")}</td></tr>`;

  const typeChips = [chip("Total", s.total)];
  if (columns.has("youth")) {
    typeChips.push(chip("Adult", s.adult), chip("Youth", s.youth));
  }

  const rows = [
    `<tr><td colspan="2" class="mthelper-refstats-title">Referee Totals</td></tr>`,
    groupRow("By type", typeChips),
  ];

  if (columns.has("certification")) {
    const certChips = [
      chip("Total", s.total),
      ...s.byCertification.map((c) => chip(c.level, c.count)),
    ];
    rows.push(groupRow("By cert", certChips));
  }

  return (
    `<table class="mthelper-refstats-table"><tbody>${rows.join("")}</tbody></table>` +
    `<div class="mthelper-refstats-note">Counts cover only the referees listed on the current page.</div>`
  );
}

// Append a bold "Total" row to the real list table: "Total" in the Referee
// column, and the summed Games / Pending / Done in their columns. No-op when
// the view has none of those columns, or if the row is already present.
function appendListTotalRow(
  table: Element,
  columns: Map<string, number>,
  columnCount: number,
  s: RefereeListSummary
): void {
  const hasAssignments =
    columns.has("games") || columns.has("pending") || columns.has("done");
  if (!hasAssignments || columnCount === 0) return;
  if (table.querySelector(".mthelper-list-total")) return;

  const refRows = Array.from(table.querySelectorAll("tr")).filter((tr) =>
    tr.querySelector('a[href*="referee.nsf/open/"][href*="opendocument"]')
  );
  const lastRow = refRows[refRows.length - 1];
  if (!lastRow) return;

  const font = (inner: string) => `<font size="2" face="Calibri">${inner}</font>`;
  const nameIdx = columns.get("referee") ?? 0;
  const cellFor = (i: number): string => {
    if (i === nameIdx) return font("<b>Total</b>");
    if (columns.get("games") === i) return font(`<b>${s.games}</b>`);
    if (columns.get("pending") === i) return font(`<b>${s.pending}</b>`);
    if (columns.get("done") === i) return font(`<b>${s.done}</b>`);
    return "";
  };

  const tr = document.createElement("tr");
  tr.className = "mthelper-list-total";
  tr.setAttribute("valign", "top");
  tr.title = "Sum across the referees listed on this page";
  let html = "";
  for (let i = 0; i < columnCount; i++) html += `<td>${cellFor(i)}</td>`;
  tr.innerHTML = html;
  lastRow.after(tr);
}

function findInsertionPoint(): { before: Element } | { after: Element } | null {
  const headers = Array.from(document.querySelectorAll<HTMLTableCellElement>('td[bgcolor="#C0E1FF"]'));

  const tableOf = (el: Element): Element | null => {
    let n: Element | null = el;
    while (n && n.tagName !== "TABLE") n = n.parentElement;
    return n;
  };

  // Primary: insert immediately before the "Referee Game History" section.
  for (const h of headers) {
    if (/Referee Game History/i.test(h.textContent ?? "")) {
      const t = tableOf(h);
      if (t) return { before: t };
    }
  }

  // Fallback: insert after the last of Qualifications / Referee Notes /
  // Referee Information — whichever appears latest in document order.
  const SECTION_RE = /^(Qualifications|Referee Notes|Referee (Profile|Information))\b/i;
  let lastTable: Element | null = null;
  for (const h of headers) {
    if (SECTION_RE.test((h.textContent ?? "").trim())) {
      const t = tableOf(h);
      if (t) lastTable = t;
    }
  }
  return lastTable ? { after: lastTable } : null;
}

function collectExpandLinks(doc: Document): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    if (!/[?&]Expand=\d+/i.test(href)) continue;
    const base = location.href;
    const abs = new URL(href, base).href;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function renderShell(): string {
  const cols = BUCKETS.map(
    (b) => `<td style="background-color:#E1E1E1"><b>${escapeHtml(bucketLabel(b))}</b></td>`
  ).join("");
  const span = BUCKETS.length + 2;
  return `
    <table class="mthelper-header-table">
      <tr>
        <td style="background-color:#C0E1FF"><img src="/icons/vwicn100.gif" alt=""> Lifetime Stats</td>
      </tr>
    </table>
    <div class="mthelper-info-table-container"></div>
    <table class="mthelper-stats-table">
      <thead>
        <tr>
          <td style="background-color:#EAF4FF"></td>
          ${cols}
          <td style="background-color:#E1E1E1"><b>Total</b></td>
        </tr>
      </thead>
      <tbody class="mthelper-body">
        <tr><td colspan="${span}" class="mthelper-loading">Loading lifetime archive…</td></tr>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="${span - 1}" class="mthelper-note">Loading…</td>
          <td style="text-align:right;white-space:nowrap;padding:2px 4px">
            <button class="mthelper-refresh" title="Clear cache and reload from MatchTrak" style="font-size:11px;cursor:pointer">&#x21BA; Refresh</button>
          </td>
        </tr>
      </tfoot>
    </table>
    <div class="mthelper-source"></div>
    <div class="mthelper-loading-indicator"><span class="mthelper-spinner"></span> Loading…</div>
    <div class="mthelper-warning"></div>
  `;
}

function renderBody(agg: AggResult): string {
  const rows = ROLES.map((role) => {
    const cells = BUCKETS.map((b) => {
      const n = agg.matrix[role][b];
      const display = n === 0 ? `<span class="mthelper-zero">—</span>` : n;
      return `<td style="background-color:#EAF4FF" class="mthelper-num">${display}</td>`;
    }).join("");
    return `
      <tr>
        <td style="background-color:#E1E1E1"><b>${escapeHtml(role)}</b></td>
        ${cells}
        <td style="background-color:#EAF4FF" class="mthelper-num"><b>${agg.rowTotals[role]}</b></td>
      </tr>
    `;
  }).join("");

  const totalCells = BUCKETS.map(
    (b) => `<td style="background-color:#EAF4FF" class="mthelper-num"><b>${agg.colTotals[b]}</b></td>`
  ).join("");

  return rows + `
    <tr>
      <td style="background-color:#E1E1E1"><b>Total</b></td>
      ${totalCells}
      <td style="background-color:#C0E1FF" class="mthelper-num"><b>${agg.grand}</b></td>
    </tr>
  `;
}

// Cache helpers — keyed by referee token + URL, stored in chrome.storage.local.
// Entries expire after CACHE_TTL_MS; use the Refresh button to force early invalidation.
// refToken is included in the key so that archived pages shared across referee profiles
// are never served to the wrong referee.

function cacheKey(url: string, refToken: string): string {
  const m = /[?&]Expand=(\d+)/i.exec(url);
  const ref = encodeURIComponent(refToken);
  try {
    const u = new URL(url);
    return `mthelper:v2:${ref}:${u.hostname}${u.pathname}${m ? `:expand:${m[1]}` : u.search}`;
  } catch {
    return `mthelper:v2:${ref}:${url}`;
  }
}

function readCache(url: string, refToken: string): Promise<GameRow[] | null> {
  return new Promise((resolve) => {
    const key = cacheKey(url, refToken);
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        console.warn(TAG, "storage read error", chrome.runtime.lastError.message);
        return resolve(null);
      }
      const entry = result[key] as { rows: GameRow[]; cachedAt: number } | undefined;
      if (!entry) return resolve(null);
      if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
        chrome.storage.local.remove(key);
        return resolve(null);
      }
      // chrome.storage spreads Date objects as {}, losing all data — rehydrate from the
      // timestamp we store explicitly in writeCache.
      const rows = entry.rows.map((r) => ({
        ...r,
        date: typeof r.date === "number" ? new Date(r.date) : null,
      }));
      resolve(rows);
    });
  });
}

function writeCache(url: string, refToken: string, rows: GameRow[]): void {
  // Serialize Date objects as timestamps — chrome.storage spreads them as {}, losing all data.
  const serialized = rows.map((r) => ({ ...r, date: r.date instanceof Date ? r.date.getTime() : null }));
  chrome.storage.local.set(
    { [cacheKey(url, refToken)]: { rows: serialized, cachedAt: Date.now() } },
    () => {
      if (chrome.runtime.lastError) {
        console.warn(TAG, "storage write error", chrome.runtime.lastError.message);
      }
    }
  );
}

function clearCache(url: string, refToken: string): void {
  chrome.storage.local.remove(cacheKey(url, refToken), () => {
    if (chrome.runtime.lastError) {
      console.warn(TAG, "storage clear error", chrome.runtime.lastError.message);
    }
  });
}

async function fetchWithRetry(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let err: unknown;
    let retriable = true;
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      if (r.ok) return r.text();
      retriable = r.status === 429 || r.status >= 500;
      err = new Error(`HTTP ${r.status}`);
    } catch (e) {
      err = e;
    }
    if (!retriable || attempt >= MAX_RETRIES) throw err;
    const cap = BASE_DELAY_MS * Math.pow(2, attempt);
    await new Promise((res) => setTimeout(res, Math.random() * cap));
  }
}

function formatDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function timeActive(first: Date, last: Date): string {
  let years = last.getFullYear() - first.getFullYear();
  let months = last.getMonth() - first.getMonth();
  let days = last.getDate() - first.getDate();

  if (days < 0) {
    months -= 1;
    days += new Date(last.getFullYear(), last.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const parts: string[] = [];
  if (years > 0) parts.push(`${years} year${years !== 1 ? "s" : ""}`);
  if (months > 0) parts.push(`${months} month${months !== 1 ? "s" : ""}`);
  if (days > 0 || parts.length === 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  return parts.join(" ");
}

function renderInfoTable(agg: AggResult, datesLoading = false): string {
  const blank = `<img width="144" height="1" src="/icons/ecblank.gif" alt=""><br>`;
  const sm = `<img width="1" height="1" src="/icons/ecblank.gif" alt=""><br>`;

  const firstStr = datesLoading ? "…" : (agg.firstDate ? formatDate(agg.firstDate) : "—");
  const lastStr = datesLoading ? "…" : (agg.lastDate ? formatDate(agg.lastDate) : "—");
  const activeStr = datesLoading ? "…" : (agg.firstDate && agg.lastDate ? timeActive(agg.firstDate, agg.lastDate) : "—");

  const rows = [
    ["Date of First Game", firstStr],
    ["Date of Most Recent Game", lastStr],
    ["Active For", activeStr],
  ].map(([key, val]) => `<tr style="vertical-align:top">
      <td style="width:1%;background-color:#E1E1E1" class="mthelper-info-label">${blank}${escapeHtml(key)}</td>
      <td style="width:4%;background-color:#E1E1E1">${sm}</td>
      <td style="width:96%;color:#0000ff">${sm}${escapeHtml(val)}</td>
    </tr>`).join("");

  return `<table class="mthelper-info-table"><tbody>${rows}</tbody></table>`;
}

function bucketLabel(bucket: string): string {
  return bucket === "U99" ? "Adult" : bucket;
}

function escapeHtml(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
