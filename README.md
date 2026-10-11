# GameDock — Gaming Toolkit

GameDock is a static, browser-based gaming toolkit designed for free GitHub Pages hosting. It combines an aim trainer, a live Minecraft Modrinth explorer, and practical gaming utilities. No account or framework is required.

## Features

### Aim Trainer
- **Flick challenge:** 30-second rounds with randomly positioned targets, hits, misses and accuracy.
- **Tracking challenge:** follow a moving target; score reflects the portion of measured frames spent on target.
- **Reaction test:** five green-signal reaction attempts, with early clicks rejected as false starts.
- Personal bests and recent sessions are saved locally.

### Modrinth Explorer
- Real project search through Modrinth's public v2 search API.
- Search for project names or describe what you need; a lightweight keyword helper simplifies common phrases.
- Filters for project type, loader and Minecraft version.
- **Any version** checkbox to remove the version facet even if the search description contains a version number.
- Sort, pagination, project compatibility metadata and official project links.
- Save projects to My Collection.

### Gaming Toolbox
- eDPI calculator (`mouse DPI × in-game sensitivity`). This number is only directly comparable within the same game's sensitivity system.
- Editable pre-game checklist.
- Setup Vault to save DPI, sensitivity, resolution and notes per game.
- JSON backup and import for saved mods, training sessions, profiles and checklist items.

## Files

- `index.html` — app panels and accessible controls
- `styles.css` — responsive dark gaming interface
- `app.js` — Modrinth requests, aim/reaction mini-games, local storage, checklist, profiles, navigation and backup features
- `worker.js` — optional Cloudflare Worker proxy to add a unique identifying `User-Agent` to Modrinth requests

## Run locally

Serve this folder over HTTP rather than opening `index.html` as a `file://` URL. If Python is installed, run this command from the folder:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Publish on GitHub Pages

1. Create a repository, for example `gamedock`.
2. Upload `index.html`, `styles.css`, and `app.js` to the repository root. `README.md` is documentation; `worker.js` is only needed if you choose the optional proxy.
3. Open **Settings → Pages** in the repository.
4. Select **Deploy from a branch**, choose the default branch (usually `main`) and `/ (root)`, then save.
5. Open the GitHub Pages URL. Practice stats, favorites, checklist items and profiles are stored in each visitor's browser.

## Modrinth API behavior

The frontend requests `GET https://api.modrinth.com/v2/search` and builds query parameters with `URLSearchParams`; nested facets are JSON-encoded. The selected loader, version (unless **Any version** is enabled) and project type become filters. Modrinth search is keyword-based; the phrase helper is not an AI search engine. Live results are not hardcoded.

The frontend cannot freely set the browser-controlled `User-Agent` header. Modrinth recommends a uniquely identifying user agent, so an optional Cloudflare Worker proxy is included. For a public deployment, see the comments in `worker.js` and the deployment procedure below.

## Optional Cloudflare Worker proxy

1. Create a Cloudflare Worker and paste in `worker.js`.
2. Replace `ALLOWED_ORIGIN` with your exact GitHub Pages origin, for example `https://YOUR-USERNAME.github.io`.
3. Change `USER_AGENT` so it identifies GameDock and includes a suitable project contact.
4. Deploy the Worker and copy its URL, for example `https://gamedock-search.YOUR-SUBDOMAIN.workers.dev`.
5. In `app.js`, change:

   ```js
   const DIRECT_API_BASE = 'https://api.modrinth.com/v2';
   ```

   to your Worker URL (do not append `/v2`; the included worker routes `/search`).
6. Commit and push the change, then test search, sorting, version/loader filters, pagination and error states.

The example Worker is a minimal public proxy, not a complete abuse-prevention system. Restrict origins and consider rate limiting if the site receives significant traffic.

## Privacy and limitations

- GameDock does not need a login. Saved mods, practice stats, profiles and checklist data stay in local browser storage unless the user exports a backup.
- Data does not automatically sync across browsers or devices.
- The aim games run in the browser. They do not read or change aim, FPS or input behavior in other games.
- eDPI is a simple multiplication; games can use different sensitivity scales and aiming models.
- A Modrinth project listing or version list does not guarantee that every mod combination will work together. Review the official project and release page before installing mods.
- Mod search needs internet access. If the request is blocked or Modrinth is unavailable, the site displays an error and retry option.

GameDock is an independent community project and is not affiliated with Modrinth.


## GameDock v2 additions

- First-run secret-code screen with unlimited attempts and a manual Lock button. **This is only a casual client-side lock**: the code is stored in browser localStorage and can be found or bypassed by someone who can inspect the site/browser. It does not securely protect the public GitHub Pages site or data.
- Minecraft coordinate-sign practice for X, Y and Z.
- Mixed Minecraft knowledge quiz with scoring and restart.
- Mod Builder preflight panel that accepts a local ZIP selection but does not upload or compile it.

## Important: real JAR building

A static GitHub Pages site cannot run Java/Gradle to compile Fabric/Forge/NeoForge mods. The Mod Builder panel is deliberately honest about that limitation. A real JAR builder needs a build backend or a local helper, with version/loader-specific templates, dependency resolution, build logs, and careful sandboxing of uploaded source code.


## GameVerse visual refresh
The interface now uses a dark cinematic gaming dashboard with a top search bar, a compact navigation rail, a neon pink/purple featured workspace banner, updated cards, and responsive mobile navigation. The visual treatment is inspired by the supplied reference while keeping GameDock branding and features.


### Visual refresh
The current theme uses a dark charcoal base, restrained blue-violet accents, and sharper, less rounded components.


### Logo and browser tab icon
`logo.svg` is used for the visible brand mark, and `favicon.svg` is linked in `index.html` for the browser tab icon. To replace the artwork, overwrite those SVG files while keeping the filenames unchanged.
