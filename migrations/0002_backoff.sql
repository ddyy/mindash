-- Failure backoff for the refresh sweep.
--
-- The claim gate is "due" = fetched_at older than the widget's interval,
-- and a failed attempt deliberately leaves fetched_at pointing at the last
-- SUCCESS (so the card can keep showing that data). The consequence was
-- that a FAILING widget stayed permanently due and was retried on every
-- sweep - every 2 minutes - no matter how long its own interval was, and a
-- widget that had never succeeded (fetched_at IS NULL) did so forever.
--
-- Against a rate-limited API that is self-sustaining: GitHub allows 60
-- unauthenticated requests per hour per IP, and Workers egress addresses
-- are shared, so one failing widget spending 30 requests an hour retrying
-- guarantees the window never recovers.
--
-- next_attempt_at holds the earliest time the sweep may claim the widget
-- again; fail_count is the consecutive-failure run that sets how far out
-- that is. A success clears both.
ALTER TABLE refresh_state ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refresh_state ADD COLUMN next_attempt_at INTEGER;
