function removeControlChars(value: string): string {
  return [...value]
    .filter((char: string) => {
      const code = char.charCodeAt(0);
      return code >= 32;
    })
    .join("");
}

export function sanitizePathSegment(input: string): string {
  return (
    removeControlChars(input)
      .trim()
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^\.+/, "")
      .replace(/\.+$/, "")
      .slice(0, 80) || "unknown"
  );
}

export function sanitizeFileBaseName(input: string): string {
  return sanitizePathSegment(input).slice(0, 120);
}
