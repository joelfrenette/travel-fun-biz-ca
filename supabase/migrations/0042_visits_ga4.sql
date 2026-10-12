-- Growth loop WP18-F: the daily performance snapshot now fills content_performance.visits from Google Analytics (GA4)
-- sessions per landing page, one read-only request a day, when GA4 is connected.
--
-- The visits column already exists (migration 0029, nullable integer), so NO new column is needed. This file only
-- updates the column comment so the database describes what the number now means. Safe to run twice. No data is changed.
-- Until it is applied nothing breaks: the code does not depend on the comment.

comment on column public.content_performance.visits is 'Visits to this page over the last 28 days: GA4 sessions with this page as the landing page when GA4 is connected (GA4_PROPERTY_ID and the Google service account), otherwise site_visits rows; null when neither is recorded. Never a guess.';
