from datetime import datetime
from fastapi import APIRouter
from ..core.config import get_settings

router = APIRouter(tags=["health"])
settings = get_settings()


@router.get("/health")
async def health():
    return {
        "status":      "healthy",
        "service":     "funds-credit-union-analytics-api",
        "version":     settings.APP_VERSION,
        "environment": settings.ENVIRONMENT,
        "timestamp":   datetime.utcnow().isoformat(),
    }
