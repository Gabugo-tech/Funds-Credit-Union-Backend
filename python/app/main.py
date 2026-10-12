from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from .core.config import get_settings
from .core.logging import configure_logging, logger
from .routers import analytics, investments, health

# ─── Init ─────────────────────────────────────────────────────────────────────
settings = get_settings()
configure_logging()

limiter = Limiter(key_func=get_remote_address, default_limits=["120/minute"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "Funds Credit Union Analytics API starting",
        version=settings.APP_VERSION,
        env=settings.ENVIRONMENT,
    )
    yield
    logger.info("Funds Credit Union Analytics API shutting down")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="""
## Funds Credit Union Analytics API

Python/FastAPI microservice providing data analytics, investment insights,
and AI-powered financial analysis for the Funds Credit Union fintech platform.

### Capabilities
- Spending analysis by category and time period
- Portfolio performance metrics (return, Sharpe ratio, volatility)
- Asset allocation breakdown
- Portfolio history for charting
- Net worth aggregation
- Investment holdings CRUD
    """,
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# ─── Rate limiting ─────────────────────────────────────────────────────────────
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ─── Middleware ───────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1000)


# ─── Request logging ──────────────────────────────────────────────────────────
@app.middleware("http")
async def log_requests(request: Request, call_next):
    response = await call_next(request)
    logger.info(
        "request",
        method=request.method,
        path=request.url.path,
        status=response.status_code,
    )
    return response


# ─── Global exception handler ────────────────────────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("unhandled_exception", error=str(exc), path=request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "message": "An internal error occurred" if not settings.DEBUG else str(exc),
        },
    )


# ─── Routers ──────────────────────────────────────────────────────────────────
app.include_router(health.router)
app.include_router(analytics.router, prefix="/api")
app.include_router(investments.router, prefix="/api")
