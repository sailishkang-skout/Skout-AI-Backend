"""company-web bot (E1.2 scaffold).

Crawls a company website and emits RawScrapeRecord JSONL to the S3 raw zone.
Production: Playwright/httpx + shared proxy/session/UA-rotation from bots/shared.
This scaffold defines the contract-compatible shape and a dry-run entrypoint so
the pipeline can be exercised without live crawling.
"""

from __future__ import annotations

import json
import sys
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class RawScrapeRecord:
    job_id: str
    source: str
    scraped_at: str
    url: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def scrape_domain(domain: str, job_id: str) -> RawScrapeRecord:
    """Stub: returns a record shaped like a real crawl result.

    TODO(E1.2): fetch https://{domain} via proxied httpx/Playwright, parse the
    about/team pages, capture raw HTML, and upload to s3://skout-{env}-scrape/raw/.
    """
    return RawScrapeRecord(
        job_id=job_id,
        source="company-web",
        scraped_at=now_iso(),
        url=f"https://{domain}",
        payload={
            "domain": domain,
            "company_name": domain.split(".")[0].title(),
            "description": f"(stub) crawled description for {domain}",
            "team": [],
        },
        meta={"crawler": "scaffold", "proxy": None},
    )


def run(seeds: list[str]) -> list[RawScrapeRecord]:
    job_id = str(uuid.uuid4())
    return [scrape_domain(d, job_id) for d in seeds]


if __name__ == "__main__":
    domains = sys.argv[1:] or ["example.com"]
    records = run(domains)
    for record in records:
        print(json.dumps(asdict(record)))
