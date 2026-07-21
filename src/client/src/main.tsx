import { createRoot } from "react-dom/client";
import { BrowserAuthGate } from "./BrowserAuthGate";
import { ensureWmuxFonts } from "./fonts";
import { initToken } from "./token";
import "./styles.css";

initToken();

void ensureWmuxFonts()
  .catch(() => undefined)
  .then(() => {
    createRoot(document.getElementById("root") as HTMLElement).render(<BrowserAuthGate />);
  });
