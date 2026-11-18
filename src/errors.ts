export type ErrorCode =
  | "AUTH_FAILED"
  | "SSO_ACCOUNT_NEEDS_SECRET"
  | "NO_RIGHT"
  | "OUT_OF_RANGE"
  | "RANGE_TOO_LARGE"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "FILE_REF_UNKNOWN"
  | "FILE_TOO_LARGE"
  | "NOT_A_FILE"
  | "INVALID_INPUT"
  | "INTERNAL";

/** Error with a message that may safely be shown to the agent (no ids, no raw API texts). */
export class ToolError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status?: number,
    /** true = never retry automatically (wrong password/secret → avoid account lockout). */
    public fatal = false,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function toToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  return new ToolError("INTERNAL", "Internal error in the WebUntis MCP server.");
}
