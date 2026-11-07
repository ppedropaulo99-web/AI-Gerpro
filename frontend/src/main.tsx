import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatPanel } from "./components/ChatPanel.tsx";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Elemento #root não encontrado");

createRoot(root).render(
  <StrictMode>
    <ChatPanel />
  </StrictMode>,
);
