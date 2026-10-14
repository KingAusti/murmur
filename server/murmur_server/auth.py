"""Request gating: only the Murmur extension may use the server.

Any web page can send requests to 127.0.0.1, so we:
  * reject requests whose Origin is anything other than our extension,
  * require a shared token on every endpoint except /health and /pair,
  * hand out the token (/pair) only when Origin is exactly our extension
    (browsers never let a web page forge Origin).
We never send CORS headers, so web pages can't read responses either.
"""

import hmac

from fastapi import HTTPException, Request

TOKEN_HEADER = "x-murmur-token"


class Gate:
    def __init__(self, token: str, extension_ids: set[str]):
        self.token = token
        self.origins = {f"chrome-extension://{i}" for i in extension_ids}

    def origin_ok(self, request: Request) -> bool:
        origin = request.headers.get("origin")
        return origin is None or origin in self.origins

    def check_origin(self, request: Request) -> None:
        if not self.origin_ok(request):
            raise HTTPException(403, "forbidden origin")

    def check(self, request: Request) -> None:
        self.check_origin(request)
        sent = request.headers.get(TOKEN_HEADER, "")
        if not hmac.compare_digest(sent.encode(), self.token.encode()):
            raise HTTPException(401, "missing or bad token")

    def can_pair(self, request: Request) -> bool:
        return request.headers.get("origin") in self.origins
