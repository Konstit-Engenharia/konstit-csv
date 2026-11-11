export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;
  let value = bytes;
  let unitIndex = 0;
  while (unitIndex < units.length - 1 && value >= 1_024) {
    value /= 1_024;
    ++unitIndex;
  }
  const unit = units[unitIndex] ?? 'B';
  return `${value.toFixed(value >= 10 || unit === 'B' ? 0 : 1)} ${unit}`;
}
