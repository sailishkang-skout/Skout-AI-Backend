/**
 * §8.13 — Pre-action preview contract for mutating AI tool calls.
 * Surfaced in the command bar before any external side effect executes.
 */
export interface ToolActionPreview {
  toolName: string;
  scope: string;
  assumptions: string[];
  affectedRecordCount: number;
  creditCost: number;
  externalSideEffects: string[];
  args: Record<string, unknown>;
}
