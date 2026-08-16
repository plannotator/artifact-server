import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import "./index.css";

const rootElement = document.querySelector("#root");

if (!(rootElement instanceof HTMLElement)) {
  throw new Error("Artifact Server could not find its root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
