import requests

OPENROUTER_API_KEY = "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"
OPENROUTER_MODEL   = "openai/gpt-oss-120b:free"
OPENROUTER_URL     = "https://openrouter.ai/api/v1/chat/completions"

prompt = "Hello, reply with only the word SUCCESS."

try:
    resp = requests.post(
        OPENROUTER_URL,
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": OPENROUTER_MODEL,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=20,
    )
    print("Status:", resp.status_code)
    print("Response json:", resp.json())
except Exception as e:
    print("Error:", e)
