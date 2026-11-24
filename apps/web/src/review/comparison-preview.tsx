import {useEffect, useState} from "react";

import {api, type ArtifactComparison, type ArtifactVersion, type Version} from "@/api/client";
import {refinementText} from "@/i18n/messages/review-refinements";
import {reviewPartsText} from "@/i18n/messages/review-parts";
import {displayError} from "@/lib/presentation";
import {HtmlPreview, htmlFrameDocument} from "./review-preview.tsx";

const text = refinementText.compare;
const noop = () => undefined;

export function ComparisonPreview({
  comparison,
  isLight,
}: {
  readonly comparison: ArtifactComparison;
  readonly isLight: boolean;
}) {
  const [synchronized, setSynchronized] = useState(false);
  const [scroll, setScroll] = useState<{
    readonly from: string;
    readonly progress: number;
  } | null>(null);

  return (
    <section aria-label={text.sideBySide} className="as-comparison-preview">
      <label className="as-comparison-preview__sync">
        <input checked={synchronized} onChange={(event) => {
          setScroll(null);
          setSynchronized(event.currentTarget.checked);
        }} type="checkbox" />
        {text.synchronize}
      </label>
      <div className="as-comparison-preview__panes">
        {[comparison.from, comparison.to].map((version) => (
          <ComparisonPane
            isLight={isLight}
            key={version.id}
            onScroll={(progress) => {
              if (synchronized) setScroll({from: version.id, progress});
            }}
            position={synchronized && scroll?.from !== version.id ? scroll : null}
            version={version}
          />
        ))}
      </div>
    </section>
  );
}

function ComparisonPane({
  isLight,
  onScroll,
  position,
  version,
}: {
  readonly isLight: boolean;
  readonly onScroll: (progress: number) => void;
  readonly position: {readonly progress: number} | null;
  readonly version: Version;
}) {
  const {artifactId, id, number, projectId} = version;
  const [loaded, setLoaded] = useState<ArtifactVersion | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      try {
        const result = await api.version(projectId, artifactId, id);
        if (current) setLoaded(result);
      } catch (caught) {
        if (current) setError(caught instanceof Error ? caught : new Error(reviewPartsText.preview.failed));
      }
    };
    void load();
    return () => { current = false; };
  }, [artifactId, id, projectId]);

  const manifest = loaded?.manifest;
  const entry = manifest?.entries.find(({path, mediaType}) =>
    path === manifest.entryPath && mediaType.split(";")[0]?.trim().toLowerCase() === "text/html"
  );
  let content: React.ReactNode;
  if (error !== null) {
    content = <p role="alert">{displayError(error)}</p>;
  } else if (loaded === null) {
    content = <p role="status">{reviewPartsText.preview.loadingVersion}</p>;
  } else if (entry === undefined) {
    content = <p>{text.unavailable(number)}</p>;
  } else {
    content = <HtmlPreview
      annotateModeActive={false}
      annotations={[]}
      artifactId={artifactId}
      comparison={{onScroll, position, title: text.preview(number)}}
      entry={entry}
      isLight={isLight}
      onAnnotateModeChange={noop}
      onSelectAnnotation={noop}
      onSubmitAnnotation={() => Promise.resolve(false)}
      onUnanchoredChange={noop}
      projectId={projectId}
      readOnly
      renderDocument={htmlFrameDocument}
      selectedThreadId={null}
      version={loaded}
    />;
  }
  return (
    <div className="as-comparison-preview__pane">
      <h2>{text.preview(number)}</h2>
      <div className="as-comparison-preview__document">{content}</div>
    </div>
  );
}
