# regret_model.py
import os
import json
from datetime import datetime
from typing import Dict, Any
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

import google.generativeai as genai

api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    raise ValueError("GEMINI_API_KEY environment variable is not set. Please set it in your .env file or environment.")

genai.configure(api_key=api_key)

# List of model names to try in order
AVAILABLE_MODELS = [
    "gemini-2.5-flash"
]

# Cache the working model name
_cached_model_name = None

def get_available_model():
    """Return the cached model name or default to gemini-pro"""
    global _cached_model_name
    if _cached_model_name:
        return _cached_model_name
    # Default to gemini-pro, will be updated on first successful call
    return "gemini-pro"

REGRET_SYSTEM_PROMPT = """
You are RegretGPT, an assistant that predicts whether a user will regret an action within the next 24 hours.
You are blunt, sarcastic, and slightly toxic, but not abusive.

Given:
- The website URL
- The current time
- What the user is typing
- A brief context label (like 'messaging', 'email', 'finance')

You must:
1. Return a "regret_score" from 0 to 100, where:
   - 0–20: very safe
   - 20–50: mildly risky
   - 50–80: risky
   - 80–100: extremely regretful
2. Explain in one sentence why.
3. Decide an "intervention_strength" as one of:
   - "NONE" (no popup)
   - "WARN" (light warning popup)
   - "PUZZLE" (require puzzle before proceeding)
   - "BLOCK_HARD" (strongly discourage and gate behind puzzle)
4. Craft a short, snarky one-liner "llm_message" (max 1 sentence).
5. Optionally simulate a short "future_regret_simulation" (1–3 short sentences) describing how the user might feel later.

Return a JSON object with keys:
- regret_score (int)
- reason (string)
- intervention_strength (string)
- llm_message (string)
- future_regret_simulation (string)
"""

def classify_regret(payload: Dict[str, Any]) -> Dict[str, Any]:
  url = payload.get("url", "")
  text = payload.get("typed_text", "")
  time_iso = payload.get("time_iso")
  context = payload.get("context", {})

  # crude time interpretation
  hour = None
  if time_iso:
    try:
      dt = datetime.fromisoformat(time_iso.replace("Z", "+00:00"))
      hour = dt.hour
    except Exception:
      hour = None

  user_prompt = {
    "url": url,
    "typed_text": text,
    "time_iso": time_iso,
    "hour": hour,
    "context": context,
  }

  try:
    global _cached_model_name
    import time
    
    # Try models in order until one works
    last_error = None
    response = None
    max_retries = 3
    retry_delay = 1  # seconds
    
    for model_name in AVAILABLE_MODELS:
      for attempt in range(max_retries):
        try:
          # Configure the model with system instruction
          model = genai.GenerativeModel(
            model_name=model_name,
            system_instruction=REGRET_SYSTEM_PROMPT
          )

          # Create the user prompt
          user_content = f"{user_prompt}"
          
          # Generate content with JSON response format
          response = model.generate_content(
            user_content,
            generation_config={
              "response_mime_type": "application/json",
              "temperature": 0.7,
              "max_output_tokens": 500
            }
          )
          
          # Success! Cache this model name
          if not _cached_model_name:
            _cached_model_name = model_name
            print(f"[RegretGPT] Successfully using model: {model_name}")
          break  # Exit the retry loop on success
          
        except Exception as e:
          last_error = e
          error_str = str(e)
          
          # If it's a 404 or model not found error, try next model
          if "404" in error_str or "not found" in error_str.lower() or "not supported" in error_str.lower():
            print(f"[RegretGPT] Model {model_name} not available, trying next...")
            break  # Break retry loop, try next model
          elif "429" in error_str or "quota" in error_str.lower() or "rate limit" in error_str.lower():
            # Rate limit - retry with backoff
            if attempt < max_retries - 1:
              wait_time = retry_delay * (2 ** attempt)
              print(f"[RegretGPT] Rate limited, retrying in {wait_time}s...")
              time.sleep(wait_time)
              continue
            else:
              raise
          else:
            # Other errors - retry if not last attempt
            if attempt < max_retries - 1:
              print(f"[RegretGPT] Error (attempt {attempt + 1}/{max_retries}): {error_str}, retrying...")
              time.sleep(retry_delay)
              continue
            else:
              raise
      
      if response is not None:
        break  # Exit model loop on success
    
    # If we exhausted all models without success, raise the last error
    if response is None:
      if last_error:
        raise last_error
      else:
        raise Exception("Failed to generate response from any available model")

    # Parse the response
    if response is None:
      raise Exception("No response received from model")
      
    try:
      data = json.loads(response.text)
    except (json.JSONDecodeError, AttributeError) as e:
      print(f"JSON parsing error: {e}")
      print(f"Response text: {response.text if hasattr(response, 'text') else 'No text attribute'}")
      # Fallback if JSON parsing fails
      data = {"regret_score": 0, "reason": "Failed to parse response.", "intervention_strength": "NONE", "llm_message": "Error occurred.", "future_regret_simulation": ""}
  except Exception as e:
    print(f"Error calling Gemini API: {e}")
    import traceback
    traceback.print_exc()
    # Return safe default on API error
    data = {"regret_score": 0, "reason": f"API error: {str(e)}", "intervention_strength": "NONE", "llm_message": "API error occurred.", "future_regret_simulation": ""}

  # sanitize
  regret_score = int(data.get("regret_score", 0))
  reason = data.get("reason", "No reason given.")
  strength = data.get("intervention_strength", "NONE")
  llm_msg = data.get("llm_message", "You sure about this?")
  sim = data.get("future_regret_simulation", "")

  return {
    "regret_score": regret_score,
    "reason": reason,
    "intervention_strength": strength,
    "llm_message": llm_msg,
    "simulation": sim,
  }
