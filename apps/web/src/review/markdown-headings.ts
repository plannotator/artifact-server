/** Allocate a stable heading target without collisions with earlier suffixed headings. */
export function markdownHeadingId(text: string, usedIds: Set<string>): string {
  const slug = text.toLowerCase().replace(/<[^>]*>/gu, "").replace(/[^\p{L}\p{N}_ -]/gu, "")
    .trim().replace(/\s/gu, "-") || "section";
  let id = slug;
  let suffix = 0;
  while (usedIds.has(id)) {
    suffix += 1;
    id = `${slug}-${suffix}`;
  }
  usedIds.add(id);
  return id;
}
