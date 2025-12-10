# main.py
import os
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from typing import Optional, Dict, Any
from dotenv import load_dotenv
import time
import logging

# Load environment variables
load_dotenv()

from regret_model import classify_regret

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class ClassifyRequest(BaseModel):
    typed_text: str = Field(..., min_length=1, max_length=10000, description="Text to classify")
    url: Optional[str] = Field(None, max_length=2048, description="URL where text was typed")
    time_iso: Optional[str] = Field(None, description="ISO timestamp")
    context: Optional[Dict[str, Any]] = Field(None, description="Additional context")
    
    @field_validator('typed_text')
    @classmethod
    def validate_text(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("typed_text cannot be empty")
        return v.strip()

app = FastAPI(title="RegretGPT API", version="1.0.0")

# CORS configuration - restrict to localhost in development, configure for production
allowed_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000").split(",")
if os.getenv("ENVIRONMENT") != "production":
    # In development, allow common extension origins
    allowed_origins.extend([
        "chrome-extension://*",
        "moz-extension://*"
    ])

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins if os.getenv("ENVIRONMENT") == "production" else ["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    max_age=3600,
)

# Request timeout middleware
@app.middleware("http")
async def timeout_middleware(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    return response

@app.get("/health")
async def health():
    """Health check endpoint"""
    return {
        "status": "ok",
        "message": "RegretGPT backend is running",
        "version": "1.0.0"
    }

@app.post("/classify")
async def classify(req: ClassifyRequest):
    """
    Classify text for regret potential.
    
    Returns a regret score (0-100) and intervention recommendations.
    """
    try:
        logger.info(f"Classifying text (length: {len(req.typed_text)}) from {req.url}")
        
        # Additional validation
        if len(req.typed_text) > 10000:
            raise ValueError("Text exceeds maximum length of 10000 characters")
        
        result = classify_regret(req.model_dump())
        
        # Validate result structure
        if not isinstance(result.get("regret_score"), int):
            raise ValueError("Invalid regret_score in response")
        
        logger.info(f"Classification complete: score={result.get('regret_score')}")
        return result
        
    except ValueError as e:
        logger.warning(f"Validation error: {e}")
        return JSONResponse(
            status_code=400,
            content={
                "regret_score": 0,
                "reason": f"Validation error: {str(e)}",
                "intervention_strength": "NONE",
                "llm_message": "Invalid input.",
                "simulation": "",
            }
        )
    except Exception as e:
        logger.error(f"Error in classify endpoint: {e}", exc_info=True)
        # Return a safe default response instead of crashing
        return JSONResponse(
            status_code=500,
            content={
                "regret_score": 0,
                "reason": f"Backend error: {str(e)}",
                "intervention_strength": "NONE",
                "llm_message": "Backend error occurred.",
                "simulation": "",
            }
        )

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "0.0.0.0")
    logger.info(f"Starting RegretGPT backend on {host}:{port}")
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info",
        timeout_keep_alive=30
    )
