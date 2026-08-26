import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installDraftGuard } from "@/components/comments/comment-drafts";

import { ReviewApp } from "./review-app.tsx";
import "../index.css";
import "./review.css";

// Lives for the whole session, above every route: the leave prompt and the
// logout purge must not depend on which screen is mounted.
installDraftGuard();

const initialTheme = window.localStorage.getItem("artifact-review-theme") === "dawn"
  ? "dawn"
  : "moon";
document.documentElement.dataset["reviewTheme"] = initialTheme;
document.documentElement.classList.toggle("dark", initialTheme === "moon");

const rootElement = document.querySelector("#review-root");

if (!(rootElement instanceof HTMLElement)) {
  throw new Error("Artifact Server could not find its root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <ReviewApp />
  </StrictMode>,
);
