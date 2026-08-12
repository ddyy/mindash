// Ticker for clock and countdown widgets — served as /clock.js. The code
// is a real JS file imported as text; textContent updates only.
import client from "./clock.client.js";

export const CLOCK_JS: string = client;
