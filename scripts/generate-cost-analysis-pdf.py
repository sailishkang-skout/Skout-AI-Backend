#!/usr/bin/env python3
"""Generate Skout cost analysis PDF (tier-wise costs + 20% profit pricing)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

OUT = Path(__file__).resolve().parent.parent / "docs" / "Skout-Cost-Analysis.pdf"

FREE_AI, FREE_EV = 25, 5
PAID_AI, PAID_EV, PAID_SMS, PAID_CALL = 150, 80, 15, 6
CAI, CEV, CSMS, CCALL = 0.00048, 0.00178, 0.012, 0.01
PROD, CLERK_BASE, CLERK_IN, CLERK_OV = 384, 25, 50_000, 0.02
PH_FREE, PH_RATE = 1_000_000, 0.00005

TIERS = [
    ("Tier 1", 500, 300, 1.0, 50, 26),
    ("Tier 2", 5_000, 3_000, 2.2, 150, 80),
    ("Tier 3", 50_000, 30_000, 6.5, 600, 250),
]


def compute(f: int, p: int, mult: float, search: float, sentry: float) -> dict:
    tot = f + p
    infra = PROD * mult
    clerk = CLERK_BASE if tot <= CLERK_IN else CLERK_BASE + (tot - CLERK_IN) * CLERK_OV
    events = f * 300 + p * 1000
    posthog = 0 if events <= PH_FREE else (events - PH_FREE) * PH_RATE
    free_var = f * FREE_AI * CAI + f * FREE_EV * CEV
    paid_var = p * PAID_AI * CAI + p * PAID_EV * CEV + p * PAID_SMS * CSMS + p * PAID_CALL * CCALL + 2
    shared = infra + clerk + posthog + search + sentry
    total = shared + free_var + paid_var
    revenue = total / 0.8
    price = revenue / p
    return {
        "f": f,
        "p": p,
        "infra": infra,
        "clerk": clerk,
        "posthog": posthog,
        "search": search,
        "sentry": sentry,
        "free_var": free_var,
        "paid_var": paid_var,
        "shared": shared,
        "total": total,
        "free_direct": free_var / f,
        "paid_direct": paid_var / p,
        "free_fl": free_var / f + shared / tot,
        "paid_fl": paid_var / p + shared / tot,
        "revenue": revenue,
        "price": price,
        "profit": revenue - total,
    }


def money(v: float, decimals: int = 0) -> str:
    if decimals == 0:
        return f"${v:,.0f}"
    return f"${v:,.2f}"


def build_pdf(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(path),
        pagesize=letter,
        rightMargin=0.65 * inch,
        leftMargin=0.65 * inch,
        topMargin=0.65 * inch,
        bottomMargin=0.65 * inch,
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle("Title", parent=styles["Heading1"], fontSize=20, spaceAfter=6)
    h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=13, spaceBefore=14, spaceAfter=8)
    body = ParagraphStyle("Body", parent=styles["Normal"], fontSize=10, leading=14, spaceAfter=8)
    small = ParagraphStyle("Small", parent=styles["Normal"], fontSize=8, textColor=colors.grey, leading=11)

    story: list = []
    story.append(Paragraph("Skout AI — Cost Analysis", title))
    story.append(
        Paragraph(
            f"Platform cost model by user tier · Generated {date.today().isoformat()}",
            small,
        )
    )
    story.append(Spacer(1, 0.15 * inch))
    story.append(
        Paragraph(
            "Estimates include AWS production infrastructure (scaled by tier), core SaaS "
            "(Clerk, Sentry, PostHog, managed OpenSearch), and variable usage (AI, email "
            "verification, Telnyx SMS/voice). Free users pay $0; paid-user price below "
            "targets <b>20% profit margin on revenue</b> (profit = 20% of revenue).",
            body,
        )
    )

    story.append(Paragraph("Recommended paid-user price (20% profit)", h2))
    price_rows = [["Tier", "Free users", "Paid users", "Total cost / mo", "Price / paid user / mo"]]
    for name, f, p, mult, search, sentry in TIERS:
        r = compute(f, p, mult, search, sentry)
        price_rows.append(
            [name, f"{f:,}", f"{p:,}", money(r["total"]), money(r["price"], 2)]
        )
    t = Table(price_rows, colWidths=[1.0 * inch, 1.0 * inch, 1.0 * inch, 1.35 * inch, 1.5 * inch])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(t)

    story.append(Paragraph("Cost per user (tier-wise)", h2))
    cpu_rows = [
        [
            "Tier",
            "Free direct",
            "Paid direct",
            "Free fully loaded",
            "Paid fully loaded",
        ]
    ]
    for name, f, p, mult, search, sentry in TIERS:
        r = compute(f, p, mult, search, sentry)
        cpu_rows.append(
            [
                name,
                money(r["free_direct"], 2),
                money(r["paid_direct"], 2),
                money(r["free_fl"], 2),
                money(r["paid_fl"], 2),
            ]
        )
    t2 = Table(cpu_rows, colWidths=[1.0 * inch, 1.15 * inch, 1.15 * inch, 1.35 * inch, 1.35 * inch])
    t2.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(t2)
    story.append(
        Paragraph(
            "<i>Direct</i> = AI + email verification + telecom only. "
            "<i>Fully loaded</i> = direct + shared infra/SaaS allocated by headcount.",
            small,
        )
    )

    story.append(Paragraph("Profit math at recommended price", h2))
    profit_rows = [
        ["Tier", "Total cost", "Required revenue", "Monthly profit", "Margin"]
    ]
    for name, f, p, mult, search, sentry in TIERS:
        r = compute(f, p, mult, search, sentry)
        profit_rows.append(
            [
                name,
                money(r["total"]),
                money(r["revenue"]),
                money(r["profit"]),
                "20%",
            ]
        )
    t3 = Table(profit_rows, colWidths=[1.0 * inch, 1.25 * inch, 1.35 * inch, 1.25 * inch, 0.9 * inch])
    t3.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(t3)

    story.append(Paragraph("Cost breakdown by tier", h2))
    for name, f, p, mult, search, sentry in TIERS:
        r = compute(f, p, mult, search, sentry)
        story.append(Paragraph(f"<b>{name}: {f:,} free + {p:,} paid</b>", body))
        breakdown = [
            ["Line item", "Monthly"],
            ["Prod infrastructure (scaled)", money(r["infra"])],
            ["Clerk", money(r["clerk"])],
            ["PostHog", money(r["posthog"])],
            ["OpenSearch (managed)", money(r["search"])],
            ["Sentry", money(r["sentry"])],
            ["Free cohort variable", money(r["free_var"])],
            ["Paid cohort variable", money(r["paid_var"])],
            ["TOTAL", money(r["total"])],
        ]
        tb = Table(breakdown, colWidths=[3.5 * inch, 1.5 * inch])
        tb.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                    ("ALIGN", (1, 1), (1, -1), "RIGHT"),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ]
            )
        )
        story.append(tb)
        story.append(Spacer(1, 0.1 * inch))

    story.append(Paragraph("Usage assumptions (per user / month)", h2))
    usage = [
        ["Cohort", "AI actions", "Email verifies", "SMS", "Call minutes", "Analytics events"],
        ["Free", str(FREE_AI), str(FREE_EV), "0", "0", "300"],
        ["Paid", str(PAID_AI), str(PAID_EV), str(PAID_SMS), str(PAID_CALL), "1,000"],
    ]
    tu = Table(usage, colWidths=[0.9 * inch, 0.95 * inch, 1.1 * inch, 0.6 * inch, 0.95 * inch, 1.2 * inch])
    tu.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("ALIGN", (1, 1), (-1, -1), "CENTER"),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(tu)

    story.append(Paragraph("What's included vs excluded", h2))
    story.append(
        Paragraph(
            "<b>Included:</b> ECS Fargate (api, crm, ai, web, email-intel), RDS PostgreSQL, "
            "Redis, NAT/ALB/CloudFront/API Gateway, S3/logs/secrets, Clerk, Sentry, PostHog, "
            "OpenSearch, GPT-4o mini AI actions, MillionVerifier-style email checks, Telnyx SMS/voice.",
            body,
        )
    )
    story.append(
        Paragraph(
            "<b>Excluded:</b> Engineering/support/sales payroll, Unipile (LinkedIn/WhatsApp), "
            "platform-funded heavy enrichment (Hunter, ZeroBounce, phone waterfalls), Datadog APM, "
            "marketing, Razorpay fees, always-on dev environment (~$193/mo if kept running).",
            body,
        )
    )
    story.append(
        Paragraph(
            "<b>Formula:</b> Required revenue = Total monthly cost ÷ 0.80. "
            "Paid price = Required revenue ÷ number of paid users.",
            small,
        )
    )

    doc.build(story)
    print(f"Wrote {path}")


if __name__ == "__main__":
    build_pdf(OUT)
