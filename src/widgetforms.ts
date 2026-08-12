import { widgetFormsFromDefs } from "./widgets";
import { COMMON_FIELDS, type WidgetFormDesc } from "./widgets/def";

// Per-type form descriptors driving the editor's inspector and gallery.
// These CONSTRUCT raw widget objects only - validation lives solely in
// config.ts's validator, so there are no duplicate rules to drift.
// Each manifest widget's descriptor is derived from its def (see
// src/widgets/def.ts); only heartbeat - the hand-rolled push widget -
// keeps a hand-written descriptor here, spliced into its gallery slot.

export type { FieldDesc, WidgetFormDesc } from "./widgets/def";

const HEARTBEAT_FORM: WidgetFormDesc = {
  type: "heartbeat",
  title: "Heartbeat monitor",
  icon: "🫀",
  category: "Monitoring",
  description: "Cron jobs and scripts report in; late or missed runs turn red.",
  requirements: "After saving, create its push token under Settings - Push tokens.",
  fields: [
    ...COMMON_FIELDS,
    { key: "expect_every", label: "Expected every", kind: "interval", required: true, placeholder: "24h", prefill: "24h" },
    { key: "anchor", label: "Anchor (HH:MM UTC)", kind: "anchor", placeholder: "02:00" },
    { key: "grace", label: "Grace period", kind: "interval", required: true, placeholder: "1h", prefill: "1h" },
    { key: "history", label: "History bars", kind: "number", advanced: true, placeholder: "10" },
    {
      key: "fields",
      label: "Payload fields (Label: dot.path - one per line)",
      kind: "fieldmap",
      advanced: true,
      placeholder: "Size: bytes",
    },
  ],
};

const LOG_FORM: WidgetFormDesc = {
  type: "log",
  title: "Push log",
  icon: "\u{1F4E8}",
  category: "Monitoring",
  description: "Lines pushed in over HTTP - cron output, CI results, agent updates.",
  requirements: "After saving, create its push token under Settings - Push tokens.",
  fields: [
    ...COMMON_FIELDS,
    { key: "limit", label: "Messages to show", kind: "number", advanced: true, placeholder: "8" },
  ],
};

// The push widgets sit in their historical gallery slot (after json-api).
const HEARTBEAT_GALLERY_INDEX = 4;

export const WIDGET_FORMS: WidgetFormDesc[] = (() => {
  const forms = widgetFormsFromDefs();
  forms.splice(HEARTBEAT_GALLERY_INDEX, 0, HEARTBEAT_FORM, LOG_FORM);
  return forms;
})();
