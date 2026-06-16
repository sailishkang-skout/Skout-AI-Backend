const HUBSPOT_AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const HUBSPOT_API = "https://api.hubapi.com";

export interface HubSpotTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  portalId?: string;
}

export function buildHubSpotAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(HUBSPOT_AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "crm.objects.contacts.write oauth");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export async function exchangeHubSpotCode(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<HubSpotTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
  });

  const res = await fetch(HUBSPOT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot token exchange failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

export async function refreshHubSpotToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<HubSpotTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
  });

  const res = await fetch(HUBSPOT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot token refresh failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

export interface HubSpotContactInput {
  prospectId: string;
  email?: string;
  firstname?: string;
  lastname?: string;
  company?: string;
  jobtitle?: string;
}

export async function batchCreateHubSpotContacts(
  accessToken: string,
  contacts: HubSpotContactInput[]
): Promise<{ created: number; errors: string[] }> {
  const inputs = contacts
    .filter((c) => c.email)
    .map((c) => ({
      properties: {
        email: c.email!,
        ...(c.firstname ? { firstname: c.firstname } : {}),
        ...(c.lastname ? { lastname: c.lastname } : {}),
        ...(c.company ? { company: c.company } : {}),
        ...(c.jobtitle ? { jobtitle: c.jobtitle } : {}),
      },
    }));

  if (!inputs.length) {
    return { created: 0, errors: ["No contacts with email addresses"] };
  }

  const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/batch/create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot contact create failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { results?: unknown[] };
  return { created: data.results?.length ?? inputs.length, errors: [] };
}
