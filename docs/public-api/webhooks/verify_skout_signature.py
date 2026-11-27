"""Reference verifier for Skout webhook signatures (public API PRD JOB-4), Python 3.8+, standard library only.

Every delivery carries:  Skout-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>
Verify against the RAW request body (bytes, before JSON parsing), reject anything older than 5 minutes,
and compare in constant time. Use the endpoint's signing secret from POST /webhooks.
"""
import hashlib
import hmac
import sys
import time


def verify_skout_signature(secret: str, header: str, raw_body: bytes, tolerance_seconds: int = 300, now: float = None) -> bool:
    if not header:
        return False
    pairs = [part.strip().split("=", 1) for part in header.split(",")]
    timestamps = [p[1] for p in pairs if len(p) == 2 and p[0] == "t"]
    try:
        t = int(timestamps[0])
    except (IndexError, ValueError):
        return False
    if abs((time.time() if now is None else now) - t) > tolerance_seconds:
        return False
    signed = str(t).encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(p[1], expected) for p in pairs if len(p) == 2 and p[0] == "v1")


# Example (Flask):
#   @app.post("/skout")
#   def skout():
#       if not verify_skout_signature(SECRET, request.headers.get("Skout-Signature", ""), request.get_data()):
#           abort(400)
#       event = request.get_json()  # event["type"], event["data"]
#       return "", 200

if __name__ == "__main__":
    # CLI used by Skout's tests: verify_skout_signature.py <secret> <header>  (raw body on stdin); exit 0 if valid.
    ok = verify_skout_signature(sys.argv[1], sys.argv[2], sys.stdin.buffer.read())
    sys.exit(0 if ok else 1)
