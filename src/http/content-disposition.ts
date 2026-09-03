const unsafeFilenameCharacters = /[/\\?%*:|"<>]/u;
const trailingFilenameCharacters = /[. ]+$/gu;

/** Build an attachment header with a portable fallback and a UTF-8 filename. */
export function attachmentContentDisposition(filename: string): string {
  const portable = portableDownloadFilename(filename);
  const encoded = encodeURIComponent(portable.toWellFormed()).replace(
    /[!'()*]/gu,
    (character) =>
      `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ""}`,
  );
  const ascii = portable.replace(/[^\x20-\x7e]/gu, "-");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Convert an untrusted display name into one safe portable download filename. */
export function portableDownloadFilename(filename: string): string {
  const normalized = Array.from(filename.normalize("NFC"))
    .map((character) => isUnsafeFilenameCharacter(character) ? "-" : character)
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(trailingFilenameCharacters, "");
  return normalized === "" ? "artifact" : normalized;
}

function isUnsafeFilenameCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint === undefined
    || codePoint <= 0x1f
    || codePoint === 0x7f
    || unsafeFilenameCharacters.test(character);
}
