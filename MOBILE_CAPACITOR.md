# Mobile Wrapper (Capacitor)

This project keeps the current web app untouched and uses Capacitor only as a native wrapper.

## What stays the same

- Web app remains in `frontend/public`.
- Existing backend/frontend behavior is unchanged.
- `npm start` still runs the web app as before.

## Capacitor modes

Two modes are supported through `capacitor.config.ts`:

1. **Production wrapper** (default)
   - Uses `webDir: frontend/public`.
   - Mobile app bundles the same built/static files.

2. **Development wrapper** (live URL)
   - Set `CAP_SERVER_URL` and Capacitor loads that URL.
   - Useful for live debugging against running local/remote web server.

## Install / setup

From project root:

- `npm run cap:add:android`
- `npm run cap:add:ios` (run on macOS with Xcode installed)

Then sync:

- Production mode: `npm run cap:sync`
- Dev live URL mode:
  - Windows PowerShell: `$env:CAP_SERVER_URL="http://192.168.1.20:3000"; npm run cap:sync:dev`
  - macOS/Linux: `CAP_SERVER_URL=http://192.168.1.20:3000 npm run cap:sync:dev`

`192.168.x.x` should be your machine LAN IP when testing on real devices.

## Useful commands

- `npm run cap:copy` - copy web assets to native platforms (prod mode)
- `npm run cap:copy:dev` - copy in dev mode (live URL)
- `npm run cap:open:android` - open Android Studio
- `npm run cap:open:ios` - open Xcode
- `npm run cap:run:android:dev` - run Android using `CAP_SERVER_URL`

## Optional plugins enabled

- `@capacitor/camera`
- `@capacitor/filesystem`

These are included for optional camera/file use in native builds.

## Responsive design

The web app is already responsive and keeps the same UI behavior inside Capacitor WebView. No web feature was removed or rewritten.
