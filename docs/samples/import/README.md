# Sample import files

Use these on **Import** (`/import`) to test CSV, Excel, PDF, and image/OCR parsing.

| File | Format | How to test |
|------|--------|-------------|
| [sample-prospects.csv](./sample-prospects.csv) | CSV | Direct upload |
| [sample-prospects.xlsx](./sample-prospects.xlsx) | Excel | Direct upload |
| [sample-prospects.pdf](./sample-prospects.pdf) | PDF | Text extract / OCR |
| [sample-prospects.png](./sample-prospects.png) | Image | OCR via OpenRouter |
| [sample-prospects.svg](./sample-prospects.svg) | SVG | Parsed as text (vision OCR rejects SVG) |
| [sample-prospects.txt](./sample-prospects.txt) | Plain text table | Upload as `.csv`/`.txt` |

Each file contains the same 4 prospects (name, email, domain, company, title, phone, LinkedIn, country, city).

**Tip:** Create a list named `Import smoke test` on the Import page, then open that list after commit.
