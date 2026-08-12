// Editor client (served as /editor.js). Vanilla DOM, no framework — the
// code lives in editor.client.js as a REAL JavaScript file (imported as
// text via the wrangler Text rule), so there is no template-literal
// escaping layer and no second set of backslash rules. The draft is a
// plain JSON document; every control mutates the draft, pushes an undo
// snapshot, and re-renders outline + debounced server preview. All text
// lands via textContent — the only innerHTML is the server-rendered
// preview fragment, escaped by construction upstream.
import client from "./editor.client.js";

export const EDITOR_JS: string = client;
