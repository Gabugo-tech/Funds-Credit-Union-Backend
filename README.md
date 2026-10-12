# Funds Credit Union Backend

Monorepo containing both backend services for the Funds Credit Union fintech platform.

```
backend/
├── node/       # Express API gateway  (PORT 4000)
├── python/     # FastAPI analytics    (PORT 8000)
├── package.json
└── .gitignore
```

## Quick start

### Install everything
```bash
# Node
cd node && npm install

# Python
cd python
python -m venv .venv
.venv\Scripts\activate   # Windows
pip install -r requirements.txt
```

### Run both services together
```bash
# From backend/ root (requires concurrently)
npm install
npm run dev
```

### Run individually
```bash
# Node only
npm run dev:node        # → http://localhost:4000

# Python only
npm run dev:python      # → http://localhost:8000
                        # Swagger docs: http://localhost:8000/docs
```

## Environment setup

Copy the example files and fill in your values:

```bash
cp node/.env.example   node/.env
cp python/.env.example python/.env
```

Both services share the same `JWT_SECRET` and Supabase credentials.

## Deployment on Railway

Deploy each subfolder as a **separate Railway service** in the same project:

| Service   | Root directory | Start command |
|-----------|---------------|---------------|
| `node`    | `node/`       | `npm run start` |
| `python`  | `python/`     | `uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 4` |

Each service has its own `railway.toml` that Railway picks up automatically.

## API docs

- Node gateway:  `GET /api/health`
- FastAPI:       `GET /health` · Swagger at `/docs`
