# Veritas: run locally and deploy

## What changed
- Backend no longer needs PyTorch / sentence-transformers / R. They made the Docker image huge and crashed free hosts for lack of RAM. It now installs in about a minute and uses roughly 100 MB.
- Data comes from **Google News search** (RSS, no API key). Optional: set `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` to add Google web results.
- Fixed: GDELT timeline parsing (chart was always empty), long claims breaking the search, CORS config, the frontend error handler wiping the page, and the API URL never being set.

## Run locally (PowerShell)
    cd veritas\backend
    python -m venv .venv
    .venv\Scripts\activate
    pip install -r requirements.txt
    uvicorn app.main:app --reload --port 8000

    # new terminal
    cd veritas\frontend
    python -m http.server 3000      # open http://localhost:3000

Test: http://localhost:8000/health and http://localhost:8000/docs

## Deploy the backend (Render, free)
1. Push the `veritas` folder to a GitHub repo.
2. Render dashboard -> New -> Blueprint -> pick the repo (it reads `render.yaml`).
3. When the build finishes, copy the URL, e.g. `https://veritas-backend.onrender.com`, and open `/health` to confirm.
4. Set the env var `ALLOWED_ORIGINS` to your Netlify URL (below) and redeploy.
   Free instances sleep after ~15 min idle, so the first request then takes ~30 s.

## Deploy the frontend (Netlify)
1. Edit `frontend/config.js`: `window.__API_URL__ = "https://veritas-backend.onrender.com";`
2. Netlify -> Add new site -> Deploy manually -> drag the `frontend` folder (or connect the repo with base directory `frontend`, no build command, publish directory `.`).
3. Put the Netlify URL into Render's `ALLOWED_ORIGINS`.
