export function getSpaceDisplayName(name: string, label?: string | null): string {
  if (!label || label.trim() === "") return name;
  return `${name} ${label}`.trim();
}
