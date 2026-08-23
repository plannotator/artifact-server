import { setIdentityProvider } from "@plannotator/ui/utils/identity";
import { setSkillCatalogTransport } from "@plannotator/ui/utils/skillCatalog";
import { setStorageBackend } from "@plannotator/ui/utils/storage";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ReviewFrame } from "./review-frame.tsx";
import "./review-frame.css";

// The viewer's default seams persist settings in cookies, name authors from
// that store, and lazily fetch a Plannotator skill catalog. Artifact Server
// owns the author (the server stamps it on the thread), stores nothing in the
// browser, and forbids network access from this document, so all three are
// replaced before the first render.
const reviewerStorage = new Map<string, string>();

setStorageBackend({
  getItem: (key) => reviewerStorage.get(key) ?? null,
  removeItem: (key) => {
    reviewerStorage.delete(key);
  },
  setItem: (key, value) => {
    reviewerStorage.set(key, value);
  },
});

setIdentityProvider({
  getIdentity: () => "",
  isCurrentUser: () => false,
  isEditable: () => false,
});

setSkillCatalogTransport(() => Promise.resolve([]));

const rootElement = document.querySelector("#review-root");

if (!(rootElement instanceof HTMLElement)) {
  throw new Error("Artifact Server could not find its review root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <ReviewFrame />
  </StrictMode>,
);
