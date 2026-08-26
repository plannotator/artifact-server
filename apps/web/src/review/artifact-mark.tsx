/** Artifact Server's three-shape product mark. */
export function ArtifactMark({className}: {readonly className?: string}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      <circle cx="12.125" cy="5.5" r="3.5" />
      <rect height="7" rx="1.75" width="7" x="3.75" y="12" />
      <path d="m17 11.75 4 7h-8Z" />
    </svg>
  );
}
