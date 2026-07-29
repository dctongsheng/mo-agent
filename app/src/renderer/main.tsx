import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/variables.css";
import "./styles/evolve.css";
import { App } from "./ui/App";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(<App />);
