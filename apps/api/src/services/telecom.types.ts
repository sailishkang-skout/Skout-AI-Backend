export interface BridgeCallParams {
  /** The SDR's own phone number — dialed first (E.164, e.g. +14155551234). */
  agentPhone: string;
  /** The prospect's number — dialed once the agent answers. */
  prospectPhone: string;
  /**
   * Query params appended to status + TeXML/recording webhooks so each callback can
   * attribute the call back to the right workspace/contact.
   */
  callbackParams: Record<string, string>;
}

export interface BridgeCallResult {
  callSid: string;
  status: string;
}

export interface SendSmsParams {
  /** Destination number, E.164 format (e.g. +14155551234). */
  to: string;
  body: string;
}

export interface SendSmsResult {
  messageSid: string;
  status: string;
}
