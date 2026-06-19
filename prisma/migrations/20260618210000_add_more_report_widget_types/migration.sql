-- Story 8.8 · Subtask 8.8.13 — the three "More reports" registry additions.
-- Average age / Resolution time / Workload ship as report PAGES and, because
-- every report is a registry report (the 6.3.1 widget-type registry), as
-- dashboard widget types too. Adding the enum values is the schema half of the
-- registry addition; the widgetRegistry entries + renderers are the code half.
-- (ADD VALUE is non-transactional in Postgres — each on its own statement.)
ALTER TYPE "dashboard_widget_type" ADD VALUE IF NOT EXISTS 'average_age';
ALTER TYPE "dashboard_widget_type" ADD VALUE IF NOT EXISTS 'resolution_time';
ALTER TYPE "dashboard_widget_type" ADD VALUE IF NOT EXISTS 'workload';
