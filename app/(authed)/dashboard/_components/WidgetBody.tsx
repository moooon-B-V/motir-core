'use client';

import type { DashboardWidgetDto } from '@/lib/dto/dashboards';
import type {
  AgeReportConfig,
  CreatedVsResolvedConfig,
  DistributionConfig,
  FilterResultsConfig,
  WorkloadConfig,
} from '@/lib/dashboards/widgetRegistry';
import { FilterResultsBody } from './FilterResultsBody';
import { DistributionBody } from './DistributionBody';
import { CreatedVsResolvedBody } from './CreatedVsResolvedBody';
import { AgeReportBody } from './AgeReportBody';
import { WorkloadBody } from './WorkloadBody';

// The widget-body dispatcher (6.3.5): mounts the renderer named by the 6.3.1
// registry's `rendererKind` — the UI never switches on the widget TYPE, so a
// registry addition with a known renderer kind renders with zero changes here
// (an UNKNOWN kind renders nothing rather than crash — the per-widget isolation
// rule). Each body owns its own fetch + state envelope.

export function WidgetBody({
  widget,
  customFieldNames,
  onReconfigure,
}: {
  widget: DashboardWidgetDto;
  customFieldNames?: Record<string, string>;
  /** The owner-only in-grid reconfigure action for the stale state. */
  onReconfigure?: () => void;
}) {
  switch (widget.rendererKind) {
    case 'issue_table':
      return (
        <FilterResultsBody
          source={widget.source}
          config={widget.config as FilterResultsConfig}
          onReconfigure={onReconfigure}
        />
      );
    case 'donut':
      return (
        <DistributionBody
          source={widget.source}
          config={widget.config as DistributionConfig}
          customFieldNames={customFieldNames}
          onReconfigure={onReconfigure}
        />
      );
    case 'difference_area':
      return (
        <CreatedVsResolvedBody
          source={widget.source}
          config={widget.config as CreatedVsResolvedConfig}
          onReconfigure={onReconfigure}
        />
      );
    case 'bar':
      return (
        <AgeReportBody
          type={widget.type as 'average_age' | 'resolution_time'}
          source={widget.source}
          config={widget.config as AgeReportConfig}
          onReconfigure={onReconfigure}
        />
      );
    case 'hbar':
      return (
        <WorkloadBody
          source={widget.source}
          config={widget.config as WorkloadConfig}
          onReconfigure={onReconfigure}
        />
      );
    default:
      return null;
  }
}
