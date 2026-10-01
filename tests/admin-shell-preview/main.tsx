import { createRoot } from "react-dom/client";

import "../../app/app.css";
import { AdminWelcome } from "../../app/components/admin/admin-shell";

// This standalone page previews presentation only. It never imports a route,
// Worker, authorization guard, or Access token.
createRoot(document.getElementById("root")!).render(<AdminWelcome />);
