export type ActivityLogValue = string | number | boolean | null | undefined;
export type ActivityLogFields = Record<string, ActivityLogValue>;

const REDACTED_FIELD = /\b(?:authorization|cookie|secret|token|key|signature|credential|nsec|priv|body|prompt|html|env)\b/i;
const MAX_STRING_LENGTH = 500;

function safeValue(key: string, value: ActivityLogValue): string | number | boolean | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return value;
  if (REDACTED_FIELD.test(key)) return "[redacted]";
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
}

export function activityLog(event: string, fields: ActivityLogFields = {}): void {
  const record: Record<string, string | number | boolean | null> = {
    event,
    at: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(fields)) record[key] = safeValue(key, value);
  console.log(`[levelup] ${JSON.stringify(record)}`);
}

