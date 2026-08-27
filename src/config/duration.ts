const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = DURATION_UNITS[match[2] ?? ""];
  if (!Number.isFinite(amount) || unit === undefined) throw new Error(`Invalid duration: ${value}`);
  return Math.round(amount * unit);
}

export function parseBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/i.exec(value);
  if (!match) throw new Error(`Invalid byte size: ${value}`);
  const powers: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.round(Number(match[1]) * (powers[match[2]?.toLowerCase() ?? ""] ?? 0));
}
