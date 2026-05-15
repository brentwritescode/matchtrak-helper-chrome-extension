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

  const expandLinks = collectExpandLinks(document);

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

    if (!loading) {
      const btn = section.querySelector<HTMLButtonElement>(".mthelper-refresh");
      if (btn) btn.disabled = false;
    }
  }

  function loadData(force: boolean): void {
    const archivedRows: GameRow[] = [];
    let errors = 0;
    let settled = 0;
    const total = expandLinks.length;

    if (total === 0) {
      updateTable(activeRows, [], false, 0);
      return;
    }

    updateTable(activeRows, [], true, 0, 0, total);

    for (const url of expandLinks) {
      if (force) clearCache(url);
      const cached$ = force ? Promise.resolve<GameRow[] | null>(null) : readCache(url);

      cached$
        .then((cached) => {
          if (cached) {
            for (const r of cached) archivedRows.push(r);
            return;
          }
          return fetch(url, { credentials: "same-origin" })
            .then((r) => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.text();
            })
            .then((html) => {
              const sub = new DOMParser().parseFromString(html, "text/html");
              const rows = parseArchivedRows(sub, refToken);
              writeCache(url, rows);
              for (const r of rows) archivedRows.push(r);
            });
        })
        .catch(() => {
          errors += 1;
        })
        .finally(() => {
          settled += 1;
          updateTable(activeRows, archivedRows, settled !== total, errors, settled, total);
        });
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

// Cache helpers — keyed by URL, stored in chrome.storage.local.
// Entries expire after CACHE_TTL_MS; use the Refresh button to force early invalidation.

function cacheKey(url: string): string {
  const m = /[?&]Expand=(\d+)/i.exec(url);
  try {
    const u = new URL(url);
    return `mthelper:v1:${u.hostname}${u.pathname}${m ? `:expand:${m[1]}` : u.search}`;
  } catch {
    return `mthelper:v1:${url}`;
  }
}

function readCache(url: string): Promise<GameRow[] | null> {
  return new Promise((resolve) => {
    const key = cacheKey(url);
    chrome.storage.local.get(key, (result) => {
      const entry = result[key] as { rows: GameRow[]; cachedAt: number } | undefined;
      if (!entry) return resolve(null);
      if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
        chrome.storage.local.remove(key);
        return resolve(null);
      }
      resolve(entry.rows);
    });
  });
}

function writeCache(url: string, rows: GameRow[]): void {
  chrome.storage.local.set({ [cacheKey(url)]: { rows, cachedAt: Date.now() } });
}

function clearCache(url: string): void {
  chrome.storage.local.remove(cacheKey(url));
}

function escapeHtml(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
