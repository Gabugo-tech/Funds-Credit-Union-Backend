from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # App
    APP_NAME: str = "Funds Credit Union Analytics API"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False
    ENVIRONMENT: str = "production"

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    WORKERS: int = 4

    # Supabase
    SUPABASE_URL: str
    SUPABASE_SERVICE_ROLE_KEY: str

    # JWT (shared with Node gateway for token verification)
    JWT_SECRET: str
    JWT_ALGORITHM: str = "HS256"

    # CORS
    FRONTEND_URL: str = "http://localhost:3000"
    NODE_GATEWAY_URL: str = "http://localhost:4000"

    # Rate limiting
    RATE_LIMIT_PER_MINUTE: int = 120

    @property
    def allowed_origins(self) -> list[str]:
        return [
            self.FRONTEND_URL,
            self.NODE_GATEWAY_URL,
            "https://fundscreditunion.vercel.app",
            "https://funds-credit-union-api.up.railway.app",
        ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
