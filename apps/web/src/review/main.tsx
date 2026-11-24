import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installDraftGuard } from "@/components/comments/comment-drafts";

import { htmlLang } from "@/i18n/locale";

import { ReviewApp } from "./review-app.tsx";
import "../index.css";
import "./review.css";

// Transient controls (focus-mode chrome, the shortcuts sheet) hide at rest
// only once script is running; without it they stay visible.
document.documentElement.classList.add("js");
// The interface language is fixed for the page; screen readers follow it.
document.documentElement.lang = htmlLang;

// Lives for the whole session, above every route: the leave prompt and the
// logout purge must not depend on which screen is mounted.
installDraftGuard();

const initialTheme = window.localStorage.getItem("artifact-review-theme") === "dawn"
  ? "dawn"
  : "moon";
document.documentElement.dataset["reviewTheme"] = initialTheme;
// The colour palette is a theme class (src/themes/); Plannotator is the default.
document.documentElement.classList.add("theme-plannotator");
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
