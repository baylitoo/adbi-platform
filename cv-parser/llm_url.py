"""Accept either an OpenAI-compatible base URL or a complete chat endpoint."""
from urllib.parse import urlsplit


def chat_endpoint(url):
    url = url.strip().rstrip("/")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Use an HTTP(S) URL without credentials, query parameters or fragment.")
    if parsed.path.endswith("/chat/completions"):
        return url
    return url + ("/v1" if not parsed.path else "") + "/chat/completions"
