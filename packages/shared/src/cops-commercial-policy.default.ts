// Generated from docs/ops/cops-commercial-policy.default.json by scripts/sync-cops-commercial-policy.mjs. Do not edit by hand.
export const COMMERCIAL_POLICY_DEFAULT_DATA: Record<"approval_policy" | "dunning_policy" | "price_book" | "currency_policy", unknown> = {
  "approval_policy": {
    "expires_after_days": 14,
    "discount_pct": [
      {
        "over": 10,
        "up_to": 20,
        "approvers": [
          "sales_manager"
        ]
      },
      {
        "over": 20,
        "up_to": 30,
        "approvers": [
          "sales_manager",
          "finance"
        ]
      },
      {
        "over": 30,
        "up_to": null,
        "approvers": [
          "sales_manager",
          "finance",
          "executive"
        ]
      }
    ],
    "seats": [
      {
        "over": 25,
        "up_to": 100,
        "approvers": [
          "sales_manager"
        ]
      },
      {
        "over": 100,
        "up_to": null,
        "approvers": [
          "sales_manager",
          "finance"
        ]
      }
    ],
    "contract_value_minor": {
      "USD": [
        {
          "over": 2500000,
          "up_to": 7500000,
          "approvers": [
            "sales_manager"
          ]
        },
        {
          "over": 7500000,
          "up_to": 20000000,
          "approvers": [
            "sales_manager",
            "finance"
          ]
        },
        {
          "over": 20000000,
          "up_to": null,
          "approvers": [
            "sales_manager",
            "finance",
            "executive"
          ]
        }
      ],
      "EUR": [
        {
          "over": 2300000,
          "up_to": 7000000,
          "approvers": [
            "sales_manager"
          ]
        },
        {
          "over": 7000000,
          "up_to": 18500000,
          "approvers": [
            "sales_manager",
            "finance"
          ]
        },
        {
          "over": 18500000,
          "up_to": null,
          "approvers": [
            "sales_manager",
            "finance",
            "executive"
          ]
        }
      ],
      "GBP": [
        {
          "over": 2000000,
          "up_to": 6000000,
          "approvers": [
            "sales_manager"
          ]
        },
        {
          "over": 6000000,
          "up_to": 16000000,
          "approvers": [
            "sales_manager",
            "finance"
          ]
        },
        {
          "over": 16000000,
          "up_to": null,
          "approvers": [
            "sales_manager",
            "finance",
            "executive"
          ]
        }
      ],
      "INR": [
        {
          "over": 200000000,
          "up_to": 600000000,
          "approvers": [
            "sales_manager"
          ]
        },
        {
          "over": 600000000,
          "up_to": 1600000000,
          "approvers": [
            "sales_manager",
            "finance"
          ]
        },
        {
          "over": 1600000000,
          "up_to": null,
          "approvers": [
            "sales_manager",
            "finance",
            "executive"
          ]
        }
      ]
    },
    "term_months": [
      {
        "over": 24,
        "up_to": null,
        "approvers": [
          "finance"
        ]
      }
    ],
    "free_credits": [
      {
        "over": 500,
        "up_to": 2000,
        "approvers": [
          "sales_manager"
        ]
      },
      {
        "over": 2000,
        "up_to": null,
        "approvers": [
          "sales_manager",
          "finance"
        ]
      }
    ],
    "payment_terms_net_days": [
      {
        "over": 30,
        "up_to": null,
        "approvers": [
          "finance"
        ]
      }
    ],
    "custom_clauses": {
      "approvers": [
        "legal_revops"
      ]
    },
    "non_standard_sla": {
      "approvers": [
        "legal_revops",
        "finance"
      ]
    }
  },
  "dunning_policy": {
    "stages": [
      {
        "state": "past_due",
        "from_day": 0
      },
      {
        "state": "restricted",
        "from_day": 8
      },
      {
        "state": "suspended",
        "from_day": 15
      },
      {
        "state": "closed",
        "from_day": 45
      }
    ],
    "suspend_when_provider_halted": true,
    "invoiced_accounts_auto_suspend": false
  },
  "price_book": {
    "month_to_month_surcharge_pct": 20,
    "currencies": {
      "USD": {
        "seat_month_annual_minor": 7900,
        "status": "benchmarked"
      },
      "EUR": {
        "seat_month_annual_minor": 7500,
        "status": "suggested"
      },
      "GBP": {
        "seat_month_annual_minor": 6500,
        "status": "suggested"
      },
      "INR": {
        "seat_month_annual_minor": 599900,
        "status": "suggested"
      }
    }
  },
  "currency_policy": {
    "supported": [
      "USD",
      "EUR",
      "GBP",
      "INR"
    ],
    "default_by_country": {
      "US": "USD",
      "IN": "INR",
      "GB": "GBP",
      "DE": "EUR",
      "FR": "EUR"
    },
    "fallback": "USD"
  }
};
