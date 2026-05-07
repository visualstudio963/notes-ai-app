# Mobile wrapper (Capacitor / Android APK)

The web app stays in `frontend/public`. Capacitor bundles the same static files as the Vercel/PWA build — **no duplicate business logic**.

## API URL (production backend)

- **Never** rely on `window.location.origin` for REST/Web Chat API calls in the native shell. The WebView origin is `https://localhost` (or similar), not Render.
- Central config: `frontend/public/js/config/api-base.js` exposes `API_BASE_URL` and `buildApiUrl()`.
- **Injected at deploy:** `scripts/inject-build-hash.mjs` replaces `__API_BASE_URL__` in HTML with `process.env.VITE_API_URL` or defaults to `https://notes-ai-app.onrender.com`.
- **Vercel:** set environment variable `VITE_API_URL=https://notes-ai-app.onrender.com` (or your API) so `vercel-build` injects it into every patched HTML file.
- **Capacitor APK:** run `npm run vercel-build` (or your CI inject step) **before** `npx cap copy` / `npx cap sync` so shipped HTML contains the real API base meta + `window.__APP_ENV__.VITE_API_URL`.

Meta + inline env (see `index.html`):

- `<meta name="notes-ai-api-base" content="__API_BASE_URL__" />`
- `window.__APP_ENV__.VITE_API_URL = "__API_BASE_URL__"`

## Platform helpers

- `frontend/public/js/config/platform-native.js` (load **before** `api-base.js`)
  - `isNativeApp()` → `Capacitor.isNativePlatform()`
  - Sets `document.documentElement.capacitor-native` for CSS tuning
  - Light `error` / `unhandledrejection` logging on native only

## Service worker / PWA

- `sw-register.js` **does not register** when `Capacitor.isNativePlatform()` is true — avoids double SW / WebView quirks. Web and PWA unchanged.
- Optional kill-switch: `window.__DISABLE_SERVICE_WORKER__ = true`.

## Push notifications

- Guards already use `"PushManager" in window` and `"Notification" in window`.
- `navigator.serviceWorker.ready` replaced with `getRegistration()` where needed so missing SW does **not** hang.
- Native builds use **Local Notifications** when the plugin is present; web push path stays for browsers.

## Export / downloads

- `note-export.js`: on **native app**, tries **Web Share API** with `File` (Chrome/Android WebView), then falls back to `<a download>` blob URLs (unchanged for web).

## Realtime (Socket.IO)

- `socket-client.js` uses `window.API_BASE_URL` (from `api-base.js`) instead of a hard-coded host only.

## Viewport / scroll

- Global `min-height: 100dvh` (with `100vh` fallback) on `html`, `body`, and `.app`.
- `html.capacitor-native` reduces heavy decorative blur on blobs for smoother scrolling on device.

## Config files

- `capacitor.config.ts` — `webDir: frontend/public`, optional `CAP_SERVER_URL` for live reload, `backgroundColor`, `android.allowMixedContent: false`.

## Setup commands

```bash
npm run vercel-build          # inject BUILD + API base into HTML
npm run cap:add:android       # once
npm run cap:sync
npm run cap:open:android
```

### Icons / splash

After `cap add android`, replace defaults under `android/app/src/main/res/` with your branding, or use `@capacitor/assets`.

### Permissions (minimal)

AndroidManifest is managed by Capacitor plugins. Camera/files/notifications are requested at runtime when you use those features.

## Dev live URL (LAN)

```powershell
$env:CAP_SERVER_URL="http://192.168.1.20:3000"; npm run cap:sync:dev
```

Still set `VITE_API_URL` / inject API base if the dev server HTML includes `__API_BASE_URL__` tokens.
