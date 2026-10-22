'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Calculator, Info, Users } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import type {
  BillingStatusDTO,
  CalculatorCategoriesDTO,
  CalculatorEmptyCategoryDTO,
  CalculatorEstimateDTO,
} from '@/lib/dto/billing';
import { CALCULATOR_REQUEST_LIMITS } from '@/lib/dto/billing';
import { INCLUDED_TRACKER_SEATS_PER_AI_PLAN, type BillingCadence } from '@/lib/billing/catalog';
import {
  fetchCalculatorCategories,
  fetchCalculatorEstimate,
  type CalculatorOutcome,
} from '@/lib/billing/calculatorClient';
import { fmt } from './billingFormat';

// The Calculator view on Billing & plans (Story MOTIR-8381 · MOTIR-8639) — the
// fourth view of the page. It computes nothing: the categories, the split, the
// credit range, the top-up and the plan key are the answer's; the price and pool
// of a plan the catalog lists are the catalog's; every sentence is a
// `billing.calculator.*` key. It asks nothing about a MODEL — a category lists the
// models it serves as text, and the request carries category keys only.
//
// ⚠️ The recommendation ARM is read, never derived. `ceiling.outcome` is the engine's
// own statement of which situation the high end is in, so nothing below compares a
// credit figure against a ceiling, a pool or a constant to decide it.

type Arm = 'regular' | 'larger' | 'above' | 'topup_only';

type RangeIssue = 'rangeEmpty' | 'rangeInvalid' | 'rangeOrder';
type CategoryIssue = 'categoryMissing' | 'tooManyCategories';

type CategoriesState =
  | { kind: 'loading' }
  | { kind: 'ready'; value: CalculatorCategoriesDTO }
  | { kind: 'failed' };

type ResultState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'estimate'; value: CalculatorEstimateDTO }
  | { kind: 'empty'; value: CalculatorEmptyCategoryDTO }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

export interface CalculatorViewProps {
  orgId: string;
  orgName: string;
  data: BillingStatusDTO;
  /** The page's ONE cadence value, shared with the plans view. */
  cadence: BillingCadence;
  onCadence: (cadence: BillingCadence) => void;
  /** Back to the plans view. */
  back: () => void;
  /** Open the plans view with this plan distinguished (null when it names no plan). */
  goToPlan: (planKey: string | null) => void;
}

// A whole, non-negative count typed as text. Letters, decimals, signs and blanks are
// refused before any request, each with its own sentence.
function parseCount(text: string): number | 'empty' | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty';
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : 'invalid';
}

// Presentational capitalisation at most: the engine's category rule owns the names,
// and a key→label map here would go stale the day a band is added.
function categoryLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function CalculatorView({
  orgId,
  orgName,
  data,
  cadence,
  onCadence,
  back,
  goToPlan,
}: CalculatorViewProps) {
  const t = useTranslations('billing');
  const locale = useLocale();
  const rangeId = useId();
  const [categories, setCategories] = useState<CategoriesState>({ kind: 'loading' });
  const [low, setLow] = useState('');
  const [high, setHigh] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [rangeIssue, setRangeIssue] = useState<RangeIssue | null>(null);
  const [categoryIssue, setCategoryIssue] = useState<CategoryIssue | null>(null);
  const [result, setResult] = useState<ResultState>({ kind: 'idle' });
  // Stamped on every ask and bumped on every edit: an older answer never lands under
  // newer inputs (the page's own `load()` and PlanChangeDialog guard the same way).
  const seq = useRef(0);
  const readSeq = useRef(0);

  // The state starts as `loading`, so the first read sets nothing before it answers;
  // a retry sets it itself (`retryCategories`).
  const loadCategories = useCallback(async () => {
    const mine = ++readSeq.current;
    const out = await fetchCalculatorCategories(orgId);
    if (mine !== readSeq.current) return;
    setCategories(out.kind === 'answer' ? { kind: 'ready', value: out.value } : { kind: 'failed' });
  }, [orgId]);

  useEffect(() => {
    void loadCategories();
    return () => {
      readSeq.current += 1;
      seq.current += 1;
    };
  }, [loadCategories]);

  // An edit returns the result block to not-yet-asked; the inputs themselves stay.
  const clear = useCallback(() => {
    seq.current += 1;
    setResult({ kind: 'idle' });
    setRangeIssue(null);
    setCategoryIssue(null);
  }, []);

  const ask = useCallback(async () => {
    const lo = parseCount(low);
    const hi = parseCount(high);
    if (lo === 'empty' || hi === 'empty') return void setRangeIssue('rangeEmpty');
    if (lo === 'invalid' || hi === 'invalid') return void setRangeIssue('rangeInvalid');
    if (lo > hi) return void setRangeIssue('rangeOrder');
    if (picked.length === 0) return void setCategoryIssue('categoryMissing');
    setRangeIssue(null);
    setCategoryIssue(null);
    const mine = ++seq.current;
    setResult({ kind: 'loading' });
    const out = await fetchCalculatorEstimate(orgId, {
      itemsPerMonth: { low: lo, high: hi },
      categories: picked,
      cadence,
    });
    if (mine !== seq.current) return;
    applyOutcome(out, { lo, hi }, setResult, setRangeIssue, setCategoryIssue);
  }, [low, high, picked, orgId, cadence]);

  const togglePicked = (key: string) => {
    clear();
    setPicked((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  };

  const asking = result.kind === 'loading';
  const ready = categories.kind === 'ready' ? categories.value : null;

  return (
    <>
      <header className="flex flex-col gap-1">
        <button
          type="button"
          onClick={back}
          className="flex w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t('calculator.back')}
        </button>
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {t('calculator.breadcrumb', { org: orgName })}
        </p>
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('calculator.title')}
        </h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
          {t('calculator.subtitle')}
        </p>
      </header>

      <Segmented<BillingCadence>
        label={t('plans.cadenceLabel')}
        value={cadence}
        onChange={(next) => {
          clear();
          onCadence(next);
        }}
        options={[
          { value: 'monthly', label: t('plans.monthly') },
          { value: 'annual', label: t('plans.annual') },
        ]}
      />

      <Card>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <fieldset className="flex flex-col gap-2" aria-describedby={`${rangeId}-help`}>
            <legend className="font-sans text-sm font-medium text-(--el-text)">
              {t('calculator.inputs.rangeLabel')}
            </legend>
            <div className="flex flex-wrap items-start gap-3">
              <Input
                label={t('calculator.inputs.lowLabel')}
                inputMode="numeric"
                autoComplete="off"
                value={low}
                aria-invalid={rangeIssue !== null}
                onChange={(event) => {
                  clear();
                  setLow(event.target.value);
                }}
              />
              <Input
                label={t('calculator.inputs.highLabel')}
                inputMode="numeric"
                autoComplete="off"
                value={high}
                aria-invalid={rangeIssue !== null}
                onChange={(event) => {
                  clear();
                  setHigh(event.target.value);
                }}
              />
            </div>
            <p id={`${rangeId}-help`} className="font-sans text-xs text-(--el-text-secondary)">
              {t('calculator.inputs.rangeHelp')}
            </p>
            {rangeIssue ? (
              <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
                {t(`calculator.errors.${rangeIssue}`)}
              </p>
            ) : null}
          </fieldset>

          <div className="flex flex-col gap-2">
            <span className="font-sans text-sm font-medium text-(--el-text)">
              {t('calculator.inputs.categoriesLabel')}
            </span>
            {categories.kind === 'loading' ? (
              <p role="status" className="font-sans text-sm text-(--el-text-secondary)">
                {t('states.loading')}
              </p>
            ) : null}
            {categories.kind === 'failed' ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="font-sans text-sm text-(--el-text-secondary)">
                  {t('calculator.categories.failed')}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setCategories({ kind: 'loading' });
                    void loadCategories();
                  }}
                >
                  {t('states.retry')}
                </Button>
              </div>
            ) : null}
            {ready ? (
              <div
                className="grid gap-2 sm:grid-cols-3"
                role="group"
                aria-label={t('calculator.inputs.categoriesLabel')}
              >
                {ready.categories.map((category) => {
                  const on = picked.includes(category.key);
                  const empty = category.models.length === 0;
                  const full = !on && picked.length >= CALCULATOR_REQUEST_LIMITS.maxCategories;
                  return (
                    <button
                      key={category.key}
                      type="button"
                      aria-pressed={on}
                      disabled={empty || full}
                      onClick={() => togglePicked(category.key)}
                      className="flex flex-col items-start gap-0.5 rounded-(--radius-control) border px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-left disabled:cursor-not-allowed"
                      style={{
                        borderColor: on ? 'var(--el-accent)' : 'var(--el-border)',
                        backgroundColor: on ? 'var(--el-surface)' : 'transparent',
                      }}
                    >
                      <span className="font-sans text-sm font-medium text-(--el-text)">
                        {categoryLabel(category.key)}
                      </span>
                      <span className="font-sans text-xs text-(--el-text-secondary)">
                        {empty
                          ? t('calculator.categories.empty')
                          : t('calculator.inputs.categoryExamples', {
                              models: category.models.map((m) => m.id).join(', '),
                            })}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('calculator.inputs.categoriesHelp')}
            </p>
            {categoryIssue ? (
              <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
                {t(`calculator.errors.${categoryIssue}`)}
              </p>
            ) : null}
          </div>

          <div>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={asking}
              disabled={categories.kind !== 'ready'}
              leftIcon={<Calculator className="h-4 w-4" />}
            >
              {t('calculator.inputs.submit')}
            </Button>
          </div>
        </form>
      </Card>

      <ResultBlock
        result={result}
        data={data}
        cadence={cadence}
        locale={locale}
        retry={() => void ask()}
        goToPlan={goToPlan}
      />
    </>
  );
}

// Fold one door outcome into the view's state. A refusal that names a field it owns
// renders on that field; one that names none (or one this view cannot place) renders
// as the failed state, so a validation drift surfaces rather than posing as an outage.
function applyOutcome(
  out: CalculatorOutcome<CalculatorEstimateDTO | CalculatorEmptyCategoryDTO>,
  range: { lo: number; hi: number },
  setResult: (next: ResultState) => void,
  setRangeIssue: (next: RangeIssue | null) => void,
  setCategoryIssue: (next: CategoryIssue | null) => void,
) {
  if (out.kind === 'answer') {
    return setResult(
      out.value.kind === 'empty_category'
        ? { kind: 'empty', value: out.value }
        : { kind: 'estimate', value: out.value },
    );
  }
  if (out.kind === 'unavailable') return setResult({ kind: 'unavailable' });
  if (out.kind === 'refused' && out.field) {
    if (out.field === 'categories') {
      setResult({ kind: 'idle' });
      return setCategoryIssue('tooManyCategories');
    }
    if (out.field.startsWith('itemsPerMonth')) {
      setResult({ kind: 'idle' });
      return setRangeIssue(range.lo > range.hi ? 'rangeOrder' : 'rangeInvalid');
    }
  }
  return setResult({ kind: 'failed' });
}

function ResultBlock({
  result,
  data,
  cadence,
  locale,
  retry,
  goToPlan,
}: {
  result: ResultState;
  data: BillingStatusDTO;
  cadence: BillingCadence;
  locale: string;
  retry: () => void;
  goToPlan: (planKey: string | null) => void;
}) {
  const t = useTranslations('billing');
  let body: React.ReactNode;
  switch (result.kind) {
    case 'idle':
      body = <Note>{t('calculator.result.idle')}</Note>;
      break;
    case 'loading':
      body = (
        <p role="status" className="font-sans text-sm text-(--el-text-secondary)">
          {t('calculator.result.loading')}
        </p>
      );
      break;
    case 'unavailable':
    case 'failed':
      body = (
        <div className="flex flex-wrap items-center gap-3">
          <Note>{t(`calculator.errors.${result.kind}`)}</Note>
          <Button variant="secondary" size="sm" onClick={retry}>
            {t('states.retry')}
          </Button>
        </div>
      );
      break;
    case 'empty':
      body = (
        <ul className="flex flex-col gap-1">
          {result.value.categories.map((key) => (
            <li key={key} className="font-sans text-sm text-(--el-text-secondary)">
              <span className="font-medium text-(--el-text)">{categoryLabel(key)}</span>{' '}
              {t('calculator.categories.empty')}
            </li>
          ))}
        </ul>
      );
      break;
    case 'estimate':
      body = (
        <Estimate
          answer={result.value}
          data={data}
          cadence={cadence}
          locale={locale}
          goToPlan={goToPlan}
        />
      );
      break;
  }
  return (
    <Card aria-live="polite" data-testid="calculator-result">
      {body}
    </Card>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 font-sans text-sm text-(--el-text-secondary)">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

// The engine's own discriminant — `ceiling.outcome` — and whether it names a plan.
// No credit figure is compared to decide it.
function armOf(answer: CalculatorEstimateDTO): Arm {
  switch (answer.ceiling.outcome) {
    case 'larger_pool':
      return 'larger';
    case 'top_ups_only':
      return 'above';
    case 'within_ladder':
      return answer.recommendation.planKey === null ? 'topup_only' : 'regular';
  }
}

function Estimate({
  answer,
  data,
  cadence,
  locale,
  goToPlan,
}: {
  answer: CalculatorEstimateDTO;
  data: BillingStatusDTO;
  cadence: BillingCadence;
  locale: string;
  goToPlan: (planKey: string | null) => void;
}) {
  const t = useTranslations('billing');
  const arm = armOf(answer);
  const { recommendation, topUp, ceiling, split } = answer;
  const { aiPlans, seatPlan } = data.catalog;
  const { tier, subscription } = data.motirAi;

  // The regular arm prices from the CATALOG: `recommendation.monthlyPriceUsd` is the
  // monthly equivalent (annual = yearly / 12), which would understate an annual plan.
  // The key is an open string, so the lookup may miss — and a miss keeps the answer's
  // own name rather than borrowing another entry's.
  const entry =
    arm === 'larger' ? null : (aiPlans.find((p) => p.key === recommendation.planKey) ?? null);
  const planName = entry?.name ?? recommendation.planName;
  const includedSeats =
    arm === 'topup_only'
      ? null
      : (entry?.includedTrackerSeats ?? INCLUDED_TRACKER_SEATS_PER_AI_PLAN);
  const seatFee = seatPlan.prices[cadence].amountUsd;

  const holdsPlan =
    !!tier &&
    tier.key !== 'free' &&
    (subscription.status === 'active' ||
      subscription.status === 'trialing' ||
      subscription.status === 'past_due');
  const currentPool = aiPlans.find((p) => p.key === tier?.key)?.allotment?.credits ?? null;
  const entryPool = entry?.allotment?.credits ?? null;
  const above =
    holdsPlan &&
    (arm === 'larger' ||
      ((arm === 'regular' || arm === 'above') &&
        entryPool !== null &&
        currentPool !== null &&
        entryPool > currentPool));

  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const list = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  const shares = [...new Set(split.categories.map((c) => percent.format(c.weight)))];
  const names = split.categories.map((c) => categoryLabel(c.key));
  const hasTopUp = topUp.high.credits > 0;
  const buys = arm !== 'topup_only';

  return (
    <div className="flex flex-col gap-4">
      <p className="font-sans text-sm text-(--el-text)">
        {split.count === 1
          ? t('calculator.split.one', { category: names[0] ?? '' })
          : t('calculator.split.even', {
              categories: list.format(names),
              shares: list.format(shares),
            })}
      </p>

      <div className="flex flex-col gap-1">
        <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
          {t('calculator.result.creditsLabel')}
        </span>
        <span className="font-serif text-2xl text-(--el-text)" data-testid="calculator-credits">
          {fmt(answer.credits.low, locale)} – {fmt(answer.credits.high, locale)}
        </span>
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {t('calculator.result.estimateCaveat')}
        </p>
      </div>

      {arm === 'larger' ? (
        <div
          className="flex flex-col gap-1.5 rounded-(--radius-card) border border-dashed p-(--spacing-card-padding)"
          style={{ borderColor: 'var(--el-accent)' }}
          data-testid="calculator-larger"
        >
          <Pill className="w-fit border-transparent bg-(--el-tint-lavender) text-(--el-text-strong)">
            {t('calculator.result.largerPoolLabel')}
          </Pill>
          <p className="font-sans text-sm text-(--el-text)">
            {t('calculator.result.largerPlan', { plan: planName ?? '' })}
          </p>
          <span className="font-serif text-2xl text-(--el-text)">
            {t('plans.perMoEquiv', { n: fmt(recommendation.monthlyPriceUsd, locale) })}
          </span>
          {/* The pool's size is the answer's own: a derived pool may have no catalog row. */}
          {recommendation.poolCredits ? (
            <p
              className="font-sans text-sm font-semibold text-(--el-text-strong)"
              data-testid="calculator-larger-pool"
            >
              {t('plans.creditsAllotment', { n: fmt(recommendation.poolCredits, locale) })}
            </p>
          ) : null}
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {t('calculator.result.largerPlanEstimate')}
          </p>
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {t('calculator.result.perOrg')}
          </p>
        </div>
      ) : null}

      {arm === 'regular' || arm === 'above' ? (
        <div className="flex flex-col gap-1" data-testid="calculator-plan">
          <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
            {t('calculator.result.planLabel')}
          </span>
          <span className="font-sans text-lg font-semibold text-(--el-text)">{planName}</span>
          <PlanPrice
            cadence={cadence}
            locale={locale}
            amountUsd={entry?.prices?.[cadence].amountUsd ?? recommendation.monthlyPriceUsd}
            fromCatalog={entry?.prices != null}
          />
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {t('calculator.result.perOrg')}
          </p>
        </div>
      ) : null}

      {arm === 'above' ? (
        <Note>
          {t('calculator.result.aboveTopRung', { ceiling: fmt(ceiling.credits ?? 0, locale) })}
        </Note>
      ) : null}

      {arm === 'topup_only' ? <Note>{t('calculator.result.topupOnly')}</Note> : null}

      {arm !== 'larger' && hasTopUp ? (
        <div className="flex flex-col gap-0.5" data-testid="calculator-topup">
          <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
            {t('calculator.result.topupLabel')}
          </span>
          <span className="font-sans text-sm text-(--el-text)">
            {t('topup.bundleCredits', { n: fmt(topUp.low.credits, locale) })} –{' '}
            {t('topup.bundleCredits', { n: fmt(topUp.high.credits, locale) })}
          </span>
        </div>
      ) : null}

      <p
        data-testid="calculator-seat"
        className="flex items-start gap-1.5 font-sans text-xs text-(--el-text-secondary)"
      >
        <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {includedSeats === null ? (
            t('calculator.seat.noPlan')
          ) : (
            <>
              {t('calculator.seat.included', { count: includedSeats })}{' '}
              {t(
                cadence === 'annual'
                  ? 'calculator.seat.feePerUserAnnual'
                  : 'calculator.seat.feePerUserMonthly',
                { price: fmt(seatFee, locale) },
              )}
            </>
          )}
        </span>
      </p>

      {above ? <Note>{t('calculator.result.upgradeNote')}</Note> : null}

      {buys ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            rightIcon={<ArrowRight className="h-4 w-4" />}
            onClick={() => goToPlan(recommendation.planKey)}
          >
            {t('calculator.result.goToPlan')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// A plan's price for the picked cadence, in the annotations the plan cards use: the
// annual price is the catalog's yearly figure as it stands (no division), the monthly
// price its monthly figure. An open key the catalog does not list prints the answer's
// own monthly figure.
function PlanPrice({
  cadence,
  locale,
  amountUsd,
  fromCatalog,
}: {
  cadence: BillingCadence;
  locale: string;
  amountUsd: number;
  fromCatalog: boolean;
}) {
  const t = useTranslations('billing');
  const yearly = cadence === 'annual' && fromCatalog;
  return (
    <span className="font-serif text-2xl text-(--el-text)" data-testid="calculator-price">
      {yearly
        ? t('plans.annualSub', { yr: fmt(amountUsd, locale) })
        : t('plans.perMoEquiv', { n: fmt(amountUsd, locale) })}
    </span>
  );
}
