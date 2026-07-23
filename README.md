# reshelved_1 — Netlify + Railway deployment

This folder has two independent halves, because Netlify (static host) and Railway
(persistent Node host) are different origins:

```
reshelved/
├── backend/     ← deploy to Railway (Express + SQLite API)
└── frontend/    ← deploy to Netlify (the site itself)
```

Admin auth uses a **bearer token in a header**, not a cookie — that's what makes
splitting the frontend and backend across two domains work cleanly. Cookies with
`SameSite=Strict` break across origins; a token sent via `Authorization: Bearer …`
doesn't care what domain it came from, so there's no CORS/cookie fight to have.

## 1. Deploy the backend to Railway

1. Push `backend/` to a GitHub repo (its `.gitignore` already excludes `.env` and `data.db`).
2. Railway dashboard → New Project → Deploy from GitHub repo → pick it.
3. Add a **volume** (Railway project → your service → Settings → Volumes) and mount it at
   e.g. `/data`. This is what makes your inventory survive redeploys — without it, every
   deploy wipes the SQLite file, same issue as the free tier of any host.
4. Set environment variables on the service:
   - `JWT_SECRET` — generate with `openssl rand -hex 32`
   - `ADMIN_PASSWORD_HASH` — generate with `node generate-hash.js "your-real-passcode"`
     (run this locally, don't put the plaintext passcode anywhere)
   - `DB_PATH` — `/data/data.db` (matching the volume mount path from step 3)
   - `FRONTEND_ORIGIN` — your Netlify URL once you have it, e.g. `https://reshelved.netlify.app`
   - `NODE_ENV` — `production`
5. Railway auto-detects `npm start`. Once it's live, seed it once via Railway's shell:
   `npm run seed` (or add books by hand through the admin panel after step 2 below).
6. Note the public URL Railway gives the service — you need it for the frontend.

Budget-wise: Railway's free trial credit runs out in days to weeks: plan on the ~$5/month
Hobby tier for anything you're calling live, and set a spending alert since Railway has no
hard spending cap — usage-based billing keeps going past your included credits.

## 2. Point the frontend at the backend

In `frontend/index.html`, near the top of the `<script>` block:

```js
const API_BASE = window.RESHELVED_API_BASE || 'http://localhost:3000';
```

Before deploying, either edit that fallback to your Railway URL, or add one line right
before the `<script>` tag:

```html
<script>window.RESHELVED_API_BASE = 'https://your-service.up.railway.app';</script>
```

## 3. Deploy the frontend to Netlify

1. Push `frontend/` to a repo (or drag-and-drop the folder onto Netlify's dashboard —
   it's just static files, no build step).
2. Netlify → Add new site → point it at the repo (or the drag-and-drop upload).
3. Publish directory: `.` (it's already set in `netlify.toml`).
4. Once it's live, go back to Railway and set `FRONTEND_ORIGIN` to this Netlify URL,
   so the backend's CORS check actually allows it.

## 4. Verify before sharing the URL

- Log into `/admin` with the real passcode (not the placeholder) — same checks as before:
- Enter the wrong passcode 6 times in a row and confirm the 6th comes back rate-limited,
  not just "wrong passcode" — this is what actually proves server-side limiting is live.
- Add a book through the live admin panel, confirm it shows up on Buy and (if featured) Home.
- Submit the Sell form and confirm the lead shows up when you fetch `/api/admin/leads`.
- Push a trivial change and redeploy the backend — confirm your test book survived, which
  proves the volume is actually mounted and `DB_PATH` points at it.

## What changed from the original file, and why

- The uploaded `index.html` had no backend calls at all — the Buy/Home grids were empty divs
  with nothing populating them, and the admin login form had no JS handler. This version
  wires all of that to the API above.
- Cart-line rendering interpolated book titles/authors into `innerHTML` unescaped — a stored-XSS
  path once inventory comes from a real admin form. Fixed with an `escapeHtml()` helper used
  everywhere user- or admin-supplied text gets rendered.
- Admin auth moved from an implied cookie/session model to a bearer token in
  `sessionStorage`, checked via an `Authorization` header — this is what lets the frontend and
  backend live on different domains (Netlify + Railway) without CORS/cookie complications.
  Trade-off worth knowing: a token in `sessionStorage` is readable by any script that runs on
  the page, so it's still only as safe as the page's overall XSS exposure — worth revisiting
  if this ever needs to be genuinely tamper-proof rather than "good enough for a one-person shop."
