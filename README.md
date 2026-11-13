# Haze Tracker

An installable web app (PWA) showing live haze readings for Singapore's five regions, with optional alerts when a region's PSI goes above a threshold you choose.

- **24-hr PSI** and **1-hr PM2.5** per region, from NEA via the data.gov.sg real-time API (`/v2/real-time/api/psi` and `/v2/real-time/api/pm25`). NEA publishes PSI as a 24-hour index; the hourly reading is PM2.5.
- **Alerts:** pick a region and a PSI threshold. You're notified when the PSI crosses above it, and again when it drops back.
- **Installable:** works offline (last reading) and can be added to the home screen.

## Run it

It's a static site with no build step. Serve the folder over HTTPS (or `localhost`), for example with GitHub Pages (Settings, Pages, deploy from `main`), then open it on your phone.

## Notifications: what to expect

There is no push server, so alerts depend on the device:

| Device | Alerts |
| --- | --- |
| Android Chrome, installed app | While the app is open (checks every 5 min), plus background checks roughly hourly if Chrome allows it |
| iPhone / iPad (iOS 16.4+) | Only while the app is open, and only after adding it to the Home Screen |
| Desktop browsers | While the page is open |

## Files

- `index.html`, `style.css`, `app.js`: the interface
- `core.js`: API fetching, PSI bands, settings and alert logic (shared with the service worker)
- `sw.js`: offline cache, background checks, notification clicks
- `manifest.webmanifest`, `icons/`: install metadata and the app icon (`icon.svg` is the source)

Not an official NEA product. See [haze.gov.sg](https://www.haze.gov.sg) for official advice.
