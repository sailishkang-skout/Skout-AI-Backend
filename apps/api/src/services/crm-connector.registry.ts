import type { CrmConnector } from "./crm-connector.interface.js";
import { hubspotConnector } from "./connectors/hubspot.connector.js";

const connectors = new Map<string, CrmConnector>();

export function registerCrmConnector(connector: CrmConnector): void {
  connectors.set(connector.provider.toLowerCase(), connector);
}

export function getCrmConnector(provider: string): CrmConnector | null {
  return connectors.get(provider.toLowerCase()) ?? null;
}

export function listCrmConnectors(): CrmConnector[] {
  return Array.from(connectors.values());
}

export function clearCrmConnectors(): void {
  connectors.clear();
}

// Register default built-in connectors
registerCrmConnector(hubspotConnector);

