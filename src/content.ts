import {
  ROLES,
  BUCKETS,
  extractReferee,
  parseActiveRows,
  parseArchivedRows,
  aggregate,
  dedupByGameNum,
} from "./parser";
import type { GameRow, AggResult } from "./types";

const TAG = "[MTHelper]";
const ROOT_ID = "mthelper-root";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

if (!document.getElementById(ROOT_ID)) {
  main();
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
    const all = dedupByGameNum([...active, ...archived]);
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
        `Total: ${agg.grand}`,
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
    const CONCURRENCY = 15;

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
        expandLinks = collectExpandLinks(freshDoc);
      } catch {
        errors += 1;
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
    const base = doc.location ? doc.location.href : location.href;
    const abs = new URL(href, base).href;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function renderShell(): string {
  const cols = BUCKETS.map(
    (b) => `<td bgcolor="#C0C0C0"><font size="2" face="Calibri"><b>${escapeHtml(b)}</b></font></td>`
  ).join("");
  const span = BUCKETS.length + 2;
  return `
    <table class="mthelper-header-table" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr valign="top">
        <td width="100%" bgcolor="#C0E1FF"><font size="2" face="Calibri"><img src="/icons/vwicn100.gif"> Lifetime Stats</font></td>
      </tr>
    </table>
    <div class="mthelper-info-table-container"></div>
    <table class="mthelper-stats-table" border="1" bordercolor="#efefef" cellpadding="3" cellspacing="0">
      <thead>
        <tr>
          <td bgcolor="#C0C0C0"></td>
          ${cols}
          <td bgcolor="#C0C0C0"><font size="2" face="Calibri"><b>Total</b></font></td>
        </tr>
      </thead>
      <tbody class="mthelper-body">
        <tr><td colspan="${span}" class="mthelper-loading">Loading lifetime archive…</td></tr>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="${span - 1}" class="mthelper-note">Loading…</td>
          <td align="right" style="white-space:nowrap;padding:2px 4px">
            <button class="mthelper-refresh" title="Clear cache and reload from MatchTrak" style="font-size:11px;cursor:pointer">&#x21BA; Refresh</button>
          </td>
        </tr>
      </tfoot>
    </table>
    <div class="mthelper-loading-indicator"><span class="mthelper-spinner"></span> Loading…</div>
    <div class="mthelper-warning"></div>
  `;
}

function renderBody(agg: AggResult): string {
  const f = (content: string | number) => `<font size="2" face="Calibri">${content}</font>`;

  const rows = ROLES.map((role) => {
    const cells = BUCKETS.map((b) => {
      const n = agg.matrix[role][b];
      const display = n === 0 ? `<span class="mthelper-zero">—</span>` : n;
      return `<td bgcolor="#EAF4FF" class="mthelper-num">${f(display)}</td>`;
    }).join("");
    return `
      <tr>
        <td bgcolor="#C0C0C0">${f(`<b>${escapeHtml(role)}</b>`)}</td>
        ${cells}
        <td bgcolor="#EAF4FF" class="mthelper-num">${f(`<b>${agg.rowTotals[role]}</b>`)}</td>
      </tr>
    `;
  }).join("");

  const totalCells = BUCKETS.map(
    (b) => `<td bgcolor="#EAF4FF" class="mthelper-num">${f(`<b>${agg.colTotals[b]}</b>`)}</td>`
  ).join("");

  return rows + `
    <tr>
      <td bgcolor="#C0C0C0">${f("<b>Total</b>")}</td>
      ${totalCells}
      <td bgcolor="#C0E1FF" class="mthelper-num">${f(`<b>${agg.grand}</b>`)}</td>
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
  chrome.storage.local.set({ [cacheKey(url, refToken)]: { rows: serialized, cachedAt: Date.now() } });
}

function clearCache(url: string, refToken: string): void {
  chrome.storage.local.remove(cacheKey(url, refToken));
}

async function fetchWithRetry(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let retriable = true;
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      if (r.ok) return r.text();
      retriable = r.status === 429 || r.status >= 500;
      throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      if (!retriable || attempt >= MAX_RETRIES) throw err;
    }
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
  const blank = `<img width="144" height="1" src="/icons/ecblank.gif" border="0" alt=""><br>`;
  const sm = `<img width="1" height="1" src="/icons/ecblank.gif" border="0" alt=""><br>`;

  const firstStr = datesLoading ? "…" : (agg.firstDate ? formatDate(agg.firstDate) : "—");
  const lastStr = datesLoading ? "…" : (agg.lastDate ? formatDate(agg.lastDate) : "—");
  const activeStr = datesLoading ? "…" : (agg.firstDate && agg.lastDate ? timeActive(agg.firstDate, agg.lastDate) : "—");

  const rows = [
    ["Date of First Game", firstStr],
    ["Date of Most Recent Game", lastStr],
    ["Active For", activeStr],
  ].map(([key, val]) => `<tr valign="top">
      <td width="1%" bgcolor="#E1E1E1">${blank}<font size="2" face="Calibri">${escapeHtml(key)}</font></td>
      <td width="4%" bgcolor="#E1E1E1">${sm}</td>
      <td width="96%">${sm}<font size="2" color="#0000ff" face="Calibri">${escapeHtml(val)}</font></td>
    </tr>`).join("");

  return `<table cellpadding="4" width="100%" border="0" cellspacing="0"><tbody>${rows}</tbody></table>`;
}

function escapeHtml(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
