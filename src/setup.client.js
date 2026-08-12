// First-run setup: replace the geo-IP timezone guess with the browser's
// own zone, which is what the user actually reads clocks in. Real JS file
// imported as text and served at /setup.js.
(function () {
  var input = document.getElementById("timezone");
  if (!input) return;
  var zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (e) {
    zone = "";
  }
  if (zone && zone !== input.value) {
    input.value = zone;
    var note = document.getElementById("tz-note");
    if (note) note.textContent = "Detected from your browser.";
  }

  // The weather fields only apply to the example dashboard. Without JS
  // they simply stay visible and are ignored for an empty start.
  var block = document.getElementById("weather-block");
  var radios = document.querySelectorAll('input[name="examples"]');
  if (!block || !radios.length) return;
  function sync() {
    var yes = document.querySelector('input[name="examples"][value="yes"]');
    block.hidden = !(yes && yes.checked);
  }
  for (var i = 0; i < radios.length; i++) radios[i].addEventListener("change", sync);
  sync();
})();
