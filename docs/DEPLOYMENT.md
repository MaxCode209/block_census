# Deploying the Data Site Selection App (Render)

This app runs on **Render** and deploys from your **GitHub** repo. You keep full version control; Render only runs what’s in the repo.

---

## Prerequisites

- Code in a **GitHub repo** (e.g. `MaxCode209/block_census` or your org’s repo).
- **Supabase** (or Postgres) database — connection string in `DATABASE_URL`.
- **Google Maps API key** for the map.

---

## 1. Create a Render account and connect GitHub

1. Go to [render.com](https://render.com) and sign up (use **Sign up with GitHub**).
2. Allow Render access to your GitHub account when prompted.
3. In Render, go to **Dashboard** → **New** → **Web Service**.

---

## 2. Connect your repo

1. Under **Connect a repository**, find your repo (e.g. `block_census`) and click **Connect**.
2. If the repo doesn’t appear, click **Configure account** and grant access to the org or account that owns the repo, then try again.
3. Choose the **branch** to deploy from (usually `main`).

---

## 3. Configure the Web Service

| Field | Value |
|-------|--------|
| **Name** | `data-site-selection` (or any name; becomes subdomain `*.onrender.com`) |
| **Region** | Pick one close to your team |
| **Runtime** | **Python 3** |
| **Build Command** | `pip install -r requirements.txt` |
| **Start Command** | `gunicorn --bind 0.0.0.0:$PORT app:app` |

*(If you have a `Procfile`, Render can use it instead of Start Command.)*

---

## 4. Set environment variables

In the same screen, open **Environment** (or **Environment Variables**).

Add these (use **Add Environment Variable** for each):

| Key | Value | Required |
|-----|--------|----------|
| `PYTHON_VERSION` | `3.12.0` | **Yes** — avoids Python 3.14, which breaks pandas/numpy build. |
| `DATABASE_URL` | Your Supabase (or Postgres) connection string. Use **Transaction** pooler port **6543** for Supabase. | Yes |
| `GOOGLE_MAPS_API_KEY` | Your Google Maps API key. | Yes |
| `FLASK_DEBUG` | `false` | Yes (production) |
| `SECRET_KEY` | A long random string (e.g. 32+ chars). Generate one for production. | Recommended |
| `BASE_URL` | After first deploy, set to your app URL, e.g. `https://data-site-selection.onrender.com` (no trailing slash). | Optional but good |

**Supabase:** In Supabase Dashboard → Project Settings → Database, copy the **Connection string** and choose **Transaction** (port 6543). Replace `[your-password]` with your DB password. Paste as `DATABASE_URL`.

**Google Maps:** In Google Cloud Console, restrict the key by HTTP referrer and add your Render URL (e.g. `https://*.onrender.com` or the exact URL) so the map works in production.

Add any other vars your app reads from `config` (e.g. `CENSUS_API_KEY`, `APIFY_API_TOKEN`) if you use those features.

---

## 5. Choose a plan and deploy

1. **Instance type:** **Starter** (~$7/month) for always-on, or **Free** (spins down after ~15 min idle; cold starts on first load).
2. Click **Create Web Service**.
3. Render will clone the repo, run the build command, then the start command. Watch the **Logs** for errors.
4. When the deploy succeeds, the **URL** (e.g. `https://data-site-selection.onrender.com`) appears at the top. Open it to load the map.

---

## 6. Set BASE_URL after first deploy (optional)

1. Copy your live URL (e.g. `https://data-site-selection.onrender.com`).
2. In Render → your service → **Environment** → **Add Environment Variable**.
3. Key: `BASE_URL`, Value: `https://data-site-selection.onrender.com` (no trailing slash).
4. Save; Render will redeploy. This ensures any server-generated links use the correct domain.

---

## 7. Share with your team

- **App:** Share the Render URL. Anyone with the link can use the map (no GitHub access needed).
- **Code:** Control access in GitHub (private repo, collaborators). Revoking someone’s GitHub access does not auto-revoke the app URL unless you also restrict the app (e.g. add auth later).

---

## Updating the app

- Push to the branch you connected (e.g. `main`). Render will auto-deploy.
- Or in Render → **Manual Deploy** → **Deploy latest commit**.

---

## Turning off or removing the app

| Goal | Steps |
|------|--------|
| **Stop the app** | Render Dashboard → your service → **Settings** → **Delete Web Service**. The URL will 404. |
| **Revoke Render’s GitHub access** | GitHub → **Settings** → **Applications** → **Authorized OAuth Apps** → **Render** → **Revoke**. Render can no longer pull new code. |
| **Keep code, kill hosting only** | Delete the Web Service on Render. Repo and history stay on GitHub. |

---

## Health check

- Render can use **Health Check Path**: `/ping` so it knows the app is up. In the service **Settings**, set **Health Check Path** to `/ping` if you want.

---

## Troubleshooting

- **Build fails with pandas/Cython errors (e.g. `_PyLong_AsByteArray`, `Python-3.14`):** Render is using Python 3.14, which pandas doesn’t support yet. Add environment variable **`PYTHON_VERSION`** = **`3.12.0`**, save, and **Redeploy** (Manual Deploy → Deploy latest commit). Ensure `runtime.txt` in the repo contains `python-3.12.0`.
- **Build fails:** Check **Logs** for the build step. Common: missing dependency in `requirements.txt`, wrong Python version (we use 3.12 in `runtime.txt`).
- **App crashes at start:** Check **Logs** after start. Common: missing or wrong `DATABASE_URL`, or DB not allowing connections from Render’s IPs (Supabase allows all by default).
- **Map blank or “API key invalid”:** Add your Render URL to the Google Maps key restrictions (referrers) in Google Cloud Console.
- **Export / download fails:** Frontend uses `window.location.origin`, so export works as long as users use the Render URL. No extra config needed.

Once this is set up, you only need to push to GitHub to deploy; Render handles the rest.
