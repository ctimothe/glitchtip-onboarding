import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootstrap } from "./app/bootstrap";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing");
void bootstrap(() => {
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
