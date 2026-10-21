# Runbook: recover an expired CRM OAuth connection (COPS-09, Bible Appendix I)

Use this when admins get the in-app alert "HubSpot Reconnection Required", or the connector health
shows the auth status `needs_reauth`.

## What happened

When the provider rejects the refresh token (revoked in HubSpot, the app uninstalled, the grant
expired) or answers 401, the connection is marked `needs_reauth` and the workspace's Admin and
Owner members are alerted once. Sync stops for that connection; Skout's own CRM keeps working, and
nothing in Skout is changed or deleted. Skout-originated changes keep landing in Skout and wait in
the outbound queue.

## Recover

1. Confirm: `GET /api/v1/crm/hubspot/health` shows `needs_reauth` and the last auth error.
2. An admin of the workspace reconnects from Settings → CRM sync → Reconnect. That calls
   `POST /api/v1/crm/hubspot/connect`, which starts HubSpot's OAuth; HubSpot returns to
   `/api/v1/crm/hubspot/callback`, which stores the new grant (encrypted) and sets the connection
   back to connected.
   - The person reconnecting must be able to install apps in that HubSpot portal.
   - Reconnect to the same portal. A different portal is a different CRM, and the existing links
     would point at records that are not there.
3. Pull what was missed: `POST /api/v1/crm/hubspot/poll` runs an incremental sync from the last
   checkpoint. Then replay outbound writes that failed while disconnected:
   `GET /api/v1/crm/outbound-writes` and `POST /api/v1/crm/outbound-writes/:id/replay`.
4. Check `GET /api/v1/crm/hubspot/health`: auth status connected, last sync recent, failed count
   falling.

## If the callback fails

- "redirect_uri mismatch": the API's public URL (`API_PUBLIC_URL`) does not match the redirect URL
  registered in the HubSpot app. Fix the environment value, then reconnect.
- "hubspot_not_configured": the API has no HubSpot client id or secret in this environment. They
  live only in the encrypted environment file (SOPS); ask the owner of that file to add them. Never
  send the values in chat, tickets or PRs.
- Missing scopes: the app's scopes changed. Reconnecting asks for the current scopes.

## Do not

- Do not set `crm_connections.status` back to connected in the database: the grant is still
  invalid, and the next call will fail and alert again.
- Do not disconnect and connect a new connection to "start fresh": the links and the sync history
  belong to the existing connection.
