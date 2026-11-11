-- CEO sign-off (2026-11-05): a customer is activated by their first successful campaign sent.
-- Login and onboarding milestones are still tracked, but they no longer count toward activation.
INSERT INTO "cops_activation_templates" ("workspace_id", "key", "version", "segment", "milestones")
SELECT NULL, 'default_trial', 2, NULL, '[
  {"key": "invitation_accepted", "label": "Invitation accepted", "weight": 0, "required": false, "source": "event", "event_types": ["invite.accepted"]},
  {"key": "first_login", "label": "First login", "weight": 0, "required": false, "source": "event", "event_types": ["auth.login_success"]},
  {"key": "crm_connected", "label": "CRM connected", "weight": 0, "required": false, "source": "event", "event_types": ["integration.crm_connected"]},
  {"key": "first_search", "label": "First search", "weight": 0, "required": false, "source": "event", "event_types": ["product.search"]},
  {"key": "first_export", "label": "First export", "weight": 0, "required": false, "source": "event", "event_types": ["product.export"]},
  {"key": "team_invited", "label": "Team member invited", "weight": 0, "required": false, "source": "event", "event_types": ["invite.sent"]},
  {"key": "first_campaign_sent", "label": "First campaign sent", "weight": 100, "required": true, "source": "event", "event_types": ["product.campaign_sent"]},
  {"key": "success_review", "label": "Success review completed", "weight": 0, "required": false, "source": "manual", "event_types": []}
]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM "cops_activation_templates" WHERE "workspace_id" IS NULL AND "key" = 'default_trial' AND "version" = 2
);
