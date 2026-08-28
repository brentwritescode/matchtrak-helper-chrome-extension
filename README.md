# MatchTrak Helper

Chrome extension that enhances [MatchTrak](https://www.matchtrak.com/) referee profile pages for AYSO Region 1455.

**Lifetime stats table.** When a referee profile page loads, the extension parallel-fetches every archived-month link and renders a `Role × Age-Group` summary covering active + all archived games.

**Referee-list stats.** On the *Referees > Admin - Regional > by Name* admin list, the extension injects a compact horizontal stats panel above the table — one row for the type split (total / adult / youth) and one for a dynamic breakdown by certification level, all for the current page — and appends a bold **Total** row to the list itself summing the Games / Pending / Done columns.

Pages targeted (on `www.matchtrak.com` and any `*.matchtrak.com` league-season subdomain):

- `/*/referee.nsf/open-myref-profile/*` — own profile (lifetime stats)
- `/*/referee.nsf/open/*` — admin profile view (lifetime stats)
- `/*/referee.nsf/refs-admin-regional-by-name*` — admin referee list (referee-list stats)

---

## Installation

1. Go to the [MatchTrak Helper page](https://chromewebstore.google.com/detail/matchtrak-helper/jhdcopgpkgngnfdldpgbifmabbkodnef) on the Chrome Web Store.
2. Click the blue **Add to Chrome** button.
3. Click **Add extension** on the pop-up.
4. Go to a referee's profile page — you should see the new **Lifetime Stats** section.

> If you've previously viewed a referee's stats, click the **Refresh** button in the bottom-right of the Lifetime Stats table to pull the newest data.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later (includes `npm`)
- Google Chrome

Install project dependencies once after cloning:

```bash
npm install
```

---

## Development workflow

### 1. Edit source files

All source code lives in `src/`. The two files you'll touch most often are:

| File | What it does |
| --- | --- |
| `src/parser.ts` | Pure parsing logic — extracts referee info, game rows, division/role from MatchTrak HTML. No DOM side effects. |
| `src/content.ts` | Runs in the page — orchestrates fetching, caching, and rendering the stats table. |
| `src/types.ts` | Shared TypeScript type definitions used by both files. |
| `src/styles.css` | Scoped CSS for the injected table. Referenced directly by the manifest; no build step needed. |

### 2. Build

TypeScript cannot be loaded directly by Chrome — it must be compiled first. Running the build produces `dist/content.js`, which is what the manifest loads.

```bash
npm run build
```

For continuous rebuilding while you edit (auto-recompiles on every save):

```bash
npm run dev
```

Leave this running in a terminal while you work. Each time it recompiles, reload the extension in Chrome (see below).

### 3. Load or reload in Chrome

Chrome runs the extension from the **project root directory** (the one that contains `manifest.json`). `manifest.json` tells Chrome which files to use — including `dist/content.js` and `src/styles.css` — so the build must be run before Chrome can load the extension.

**First time (one-time setup):**

1. Run `npm run build` (creates `dist/content.js`).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right toggle).
4. Click **Load unpacked**.
5. Select the **project root directory** (the folder that contains `manifest.json`). Do not select the `dist/` subfolder — Chrome needs the whole directory.

**After each code change:**

1. Run `npm run build` again (or keep `npm run dev` running so it rebuilds automatically).
2. On the `chrome://extensions` page, click the **↻ reload** icon on the MatchTrak Helper card.
3. Refresh the MatchTrak profile tab.

> `dist/` by itself is not a loadable extension — it only contains the compiled JavaScript. The full extension is the project root: `manifest.json` + `icons/` + `src/styles.css` + `dist/content.js`.

### 4. Debugging in the browser

Open DevTools on a MatchTrak profile page (right-click → Inspect → Console). The extension logs under the `[MTHelper]` prefix:

- Warnings appear if the referee name or insertion point can't be found.
- The Network tab shows one request per archived-month `Expand=N` link, all dispatched in parallel.

---

## Commands reference

| Command | What it runs | When to use |
| --- | --- | --- |
| `npm run build` | esbuild: compiles `src/` → `dist/content.js` | Before reloading the extension |
| `npm run dev` | Same as build, but watches for changes and recompiles automatically | During active development |
| `npm test` | Jest: runs all unit tests in `src/__tests__/` | After changing parser logic |
| `npm run type-check` | `tsc --noEmit`: checks types across all files without emitting output | Before committing |
| `npm run lint` | ESLint: checks code style and catches common mistakes | Before committing |
| `npm run package` | Builds and zips the extension for Chrome Web Store submission | Before submitting for review |

A typical pre-commit sequence:

```bash
npm run type-check && npm test && npm run lint && npm run build
```

---

## Running tests

Tests live in `src/__tests__/parser.test.ts` and cover the parsing logic in `parser.ts` — the part that has no browser or Chrome API dependencies and is easiest to verify automatically.

```bash
npm test
```

Expected output:

```
PASS src/__tests__/parser.test.ts
  normalizeRole
    ✓ normalizes "center" → "Center"
    ...
Tests: 87 passed, 87 total
```

The test environment uses [jsdom](https://github.com/jsdom/jsdom), which simulates a browser DOM inside Node.js. This lets tests call `new DOMParser()`, create documents, and query elements — the same APIs the extension uses — without needing a real browser.

`content.ts` is not unit-tested because it depends on the Chrome extension API (`chrome.storage`), which is only available inside a real Chrome extension context. That code is covered manually by loading the extension and watching it run on a live MatchTrak page.

---

## Type checking

TypeScript is a superset of JavaScript that adds type annotations. The compiler checks that values are used consistently (e.g. you don't pass `null` where a string is expected) and catches many bugs before you run the code.

```bash
npm run type-check
```

This produces no output if everything is correct. Any errors are printed with the file name, line number, and a description.

The `tsconfig.json` file controls type-checker settings. Key options:
- `"strict": true` — enables all strict checks (strongly recommended; catches the most bugs)
- `"noEmit": true` — type-checks only, never writes files (esbuild handles the actual compilation)

---

## Linting

ESLint enforces consistent code style and catches common mistakes (unused variables, unsafe patterns, etc.).

```bash
npm run lint
```

No output means no issues. Problems are printed with file, line, rule name, and a description. Configuration is in `eslint.config.js`.

---

## Chrome Web Store: Test Instructions

The Chrome Web Store developer dashboard has a **Test Instructions** field where you explain to Google reviewers how to verify the extension works. MatchTrak requires a real account and contains personally identifiable information (referee names, schedules, contact data), so test credentials cannot be provided to reviewers.

Google accepts a **screen recording** as a substitute. Paste the following into the Test Instructions field, replacing the video URL placeholder:

---

> This extension runs on MatchTrak (matchtrak.com), a referee management platform operated by a third party. MatchTrak accounts contain personally identifiable information (referee names, schedules, contact data), so test credentials cannot be provided to reviewers.
>
> A screen recording demonstrating the extension's full behavior is available at: [your video URL]
>
> **What the extension does:**
> When a referee profile page loads on matchtrak.com, the extension injects a "Lifetime Stats" table above the existing page content. It reads the current page's game data and fetches archived-month pages in parallel, then aggregates everything into a Role × Age-Group grid. All data stays local — nothing is transmitted off-device. Game data is cached in `chrome.storage.local` with a TTL and can be force-refreshed via the Refresh button.
>
> **Permissions used:**
> - `content_scripts` with `matches` targeting MatchTrak referee pages — the script runs in the page context and fetches archived-month pages using the user's existing MatchTrak session; no separate host permission is required
> - `storage` — used only for the local cache

---

### Recording the walkthrough video

The video should show:

1. A referee profile page loading with the extension installed
2. The Lifetime Stats table appearing and populating
3. The Refresh button clearing the cache and reloading
4. The Network tab (filtered to non-matchtrak.com destinations) confirming no data leaves the device

**How to demonstrate step 4:**

- Open DevTools (`F12` or `Cmd+Option+I`) and go to the **Network** tab
- First show the tab unfiltered so reviewers can see all fetches go to matchtrak.com
- Then type `-url:matchtrak.com` in the filter bar — this hides all matchtrak.com requests
- The tab should be empty, proving no external calls are made to analytics, APIs, or third-party services

**Note: `analytics.js` may still appear after filtering**

Even with `-url:matchtrak.com` active, a single `analytics.js` row may remain. This is Google Analytics (`google-analytics.com`), loaded by the MatchTrak page itself — not by the extension. You can prove this on camera by clicking the **Initiator** link in that row: Chrome will open the Sources panel and highlight the `<script>` tag in the MatchTrak page's own HTML. If the extension were making the request, the Initiator would show a `chrome-extension://` URL. To suppress it from the demo view entirely, add a second filter term: `-url:matchtrak.com -url:google-analytics.com`.

[Loom](https://www.loom.com) is a quick option for recording and hosting. Upload the link to the Test Instructions field before submitting for review.

---

## Publishing to the Chrome Web Store (unlisted)

Publishing as **Unlisted** means the extension won't appear in public search results — only people with the direct link can install it. This is the right choice for a small community tool like this.

### Before you submit

The Web Store requires a few things that need to be ready first:

- **Icons** — all four sizes already declared in `manifest.json` (`icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`) must be real images, not placeholders. The 128×128 icon appears on the store listing page.
- **Screenshots** — at least one screenshot of the extension running (1280×800 px recommended). Take one from a MatchTrak profile page showing the injected stats table.
- **Description** — the short description in `manifest.json` and a longer store listing description you'll write during submission.
- **Privacy disclosure** — the Web Store requires you to declare what data the extension accesses. This extension reads the current MatchTrak page and stores parsed game data locally via `chrome.storage.local`. It does not collect, transmit, or share any user data.

### Create a developer account

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in with a Google account.
3. Pay the one-time **$5 USD** registration fee (required once per developer account, not per extension).

### Package the extension

You cannot upload the whole project folder — it includes TypeScript source files, `node_modules`, config files, and other things Chrome doesn't need. The zip must contain only the files `manifest.json` references: the compiled JS, the CSS, and the icons.

Run:

```bash
npm run package
```

This builds the extension and produces `matchtrak-helper.zip` containing:

```
matchtrak-helper.zip
├── manifest.json
├── dist/
│   └── content.js
├── src/
│   └── styles.css
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

### Submit

1. In the Developer Dashboard, click **New item** and upload `matchtrak-helper.zip`.
2. Fill in the store listing: name, description, screenshots, and category (suggested: *Productivity*).
3. Under **Distribution**, set visibility to **Unlisted**.
4. Complete the **Privacy practices** tab — declare that the extension does not collect user data.
5. Click **Submit for review**.

Review typically takes 1–3 business days. You'll receive an email when it's approved or if changes are requested.

### After approval

The dashboard will show a direct install link in the form `https://chromewebstore.google.com/detail/<extension-id>`. Share this link with the referee community — anyone who opens it can install the extension directly from the Web Store.

### Publishing checklist

- [ ] All four icon sizes are real images (not placeholders)
- [ ] At least one screenshot ready (1280×800 px recommended)
- [ ] Chrome Web Store developer account created and $5 fee paid
- [ ] `npm run package` produces `matchtrak-helper.zip` without errors
- [ ] Store listing description written
- [ ] Visibility set to **Unlisted**
- [ ] Privacy practices tab completed (no user data collected)
- [ ] Submitted for review
- [ ] Direct install link shared with the referee community

---

## File layout

```
matchtrak-helper/
├── manifest.json          MV3 manifest — URL matches, permissions, entry points
├── build.js               esbuild script that compiles src/ → dist/
├── tsconfig.json          TypeScript config for source files and type-check
├── tsconfig.test.json     TypeScript config used by Jest when running tests
├── jest.config.js         Jest configuration
├── eslint.config.js       ESLint configuration
├── package.json           npm scripts and dev dependencies
├── src/
│   ├── types.ts           Shared type definitions (Role, Bucket, GameRow, etc.)
│   ├── parser.ts          Pure parsing helpers — no DOM side effects
│   ├── content.ts         Content script — runs in the page, calls parser, renders table
│   ├── styles.css         Scoped styles for the injected table
│   └── __tests__/
│       └── parser.test.ts Unit tests for parser.ts
├── dist/
│   └── content.js         Compiled JS bundle — generated by `npm run build`, do not edit
└── icons/
    └── icon*.png          Extension icons
```

Chrome loads the extension from the **project root** (the folder containing `manifest.json`). The manifest references:
- `dist/content.js` — the compiled content script (requires a build)
- `src/styles.css` — injected CSS (no build needed)
- `icons/` — extension icons

`dist/` and `node_modules/` are in `.gitignore` and are never committed. After a fresh clone, run `npm install` then `npm run build` before loading the extension in Chrome.
