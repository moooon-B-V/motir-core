'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertCircle, Check, Lock, Mail, Send, WifiOff } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Combobox } from '@/components/ui/Combobox';
import { FormField } from '@/components/ui/FormField';
import { Pill } from '@/components/ui/Pill';
import {
  ENTERPRISE_AGENT_PATHS,
  ENTERPRISE_AUTONOMIES,
  ENTERPRISE_REQUEST_LIMITS,
  ENTERPRISE_START_WHENS,
  ENTERPRISE_TEAM_SIZES,
  type EnterpriseAgentPathValue,
  type EnterpriseAutonomyValue,
  type EnterpriseRequestDTO,
  type EnterpriseRequestOrgStatus,
  type EnterpriseStartWhenValue,
  type EnterpriseTeamSizeValue,
} from '@/lib/dto/billing';
import { sendEnterpriseRequest } from '@/lib/billing/enterpriseRequestClient';

// The Enterprise card's Contact-sales dialog (Story MOTIR-7602 · Subtask
// MOTIR-7607; design `design/billing/billing--contact-sales.mock.html` panels
// 3–8, `design-notes.md` § "Amendment 2026-10-05 — Contact sales opens a
// request form"). A client island beside `PlanCard`:
//
//   · `form`    — the read-only "Sent with your request" box, then ONLY what the
//                 person alone knows (panels 3–5, 8). Validation is client-side
//                 first; the server repeats it and its 400 maps to the same
//                 field messages.
//   · `sent`    — the confirmation (panel 6). The card behind it has already
//                 re-read the open request from the server (`onRequestChanged`).
//   · `request` — the org's open request, read-only (panel 7). Reached from the
//                 card's "Request sent", and from the 409 a parallel tab causes.
//
// Five server-visible outcomes of a send: sent · 409 already open (the race lost
// to another tab or admin — it lands the person on THAT request, not an error) ·
// 403 · 400 · a network failure / 5xx, which keeps every typed value.

/** What the page read on the server for the read-only box (never trusted from the client). */
export interface ContactSalesContext {
  requesterName: string;
  requesterEmail: string;
  repositoryCount: number;
}

export interface ContactSalesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  orgName: string;
  /** The org's current Motir AI plan name, or null when it has none. */
  planName: string | null;
  /** Null when the page could not read it — the box then says "—" rather than guessing. */
  context: ContactSalesContext | null;
  /** The org's open request — when present the dialog opens on it, read-only. */
  openRequest: EnterpriseRequestDTO | null;
  /**
   * Re-read the org's open request from the server (the card's `GET`) and
   * return it. Called after a successful send and after a 409, so the card
   * reads `Request sent` from the server rather than assuming it.
   */
  onRequestChanged: () => Promise<EnterpriseRequestDTO | null | undefined>;
}

type Mode = 'form' | 'sent' | 'request';
type Refusal = 'open' | 'forbidden' | 'network' | null;
type FieldErrors = Partial<Record<'cardsPerDay' | 'parallelAgents' | 'note', string>>;

const STATUS_TINT: Record<Exclude<EnterpriseRequestOrgStatus, 'closed'>, string> = {
  received: 'bg-(--el-tint-yellow)',
  in_conversation: 'bg-(--el-tint-sky)',
  offer_sent: 'bg-(--el-tint-mint)',
};

/** A count answer: blank is "not given"; anything else must be a whole number ≥ 1. */
function parseCount(raw: string, max: number): number | null | 'invalid' {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const n = Number(trimmed);
  return n >= 1 && n <= max ? n : 'invalid';
}

export function ContactSalesDialog({
  open,
  onOpenChange,
  orgId,
  orgName,
  planName,
  context,
  openRequest,
  onRequestChanged,
}: ContactSalesDialogProps) {
  const t = useTranslations('billing.contactSales');
  const format = useFormatter();
  const fmtDate = (iso: string) =>
    format.dateTime(new Date(iso), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });

  const [mode, setMode] = useState<Mode>(openRequest ? 'request' : 'form');
  const [shown, setShown] = useState<EnterpriseRequestDTO | null>(openRequest);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal>(null);
  const [conflict, setConflict] = useState<EnterpriseRequestDTO | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const [cardsPerDay, setCardsPerDay] = useState('');
  const [parallelAgents, setParallelAgents] = useState('');
  const [agentPath, setAgentPath] = useState<EnterpriseAgentPathValue | null>(null);
  const [autonomy, setAutonomy] = useState<EnterpriseAutonomyValue | null>(null);
  const [startWhen, setStartWhen] = useState<EnterpriseStartWhenValue | null>(null);
  const [teamSize, setTeamSize] = useState<EnterpriseTeamSizeValue | null>(null);
  const [contact, setContact] = useState(context?.requesterEmail ?? '');
  const [note, setNote] = useState('');
  const [sentContact, setSentContact] = useState('');

  const ids = useId();
  const cardsId = `${ids}-cards`;
  const parallelId = `${ids}-parallel`;
  const noteId = `${ids}-note`;
  const sendSeq = useRef(0);

  function close(next: boolean) {
    // Mid-request the dialog cannot be dismissed (panel 5): the answer decides
    // what the card shows, so it must land somewhere the person can see.
    if (!next && sending) return;
    onOpenChange(next);
  }

  async function submit() {
    if (sending) return;
    const cards = parseCount(cardsPerDay, ENTERPRISE_REQUEST_LIMITS.maxCardsPerDay);
    const parallel = parseCount(parallelAgents, ENTERPRISE_REQUEST_LIMITS.maxParallelAgents);
    const next: FieldErrors = {};
    if (cards === 'invalid') next.cardsPerDay = t('errors.number');
    if (parallel === 'invalid') next.parallelAgents = t('errors.number');
    if (note.trim() === '') next.note = t('errors.note');
    setErrors(next);
    setRefusal(null);
    if (Object.keys(next).length > 0) {
      // Focus the first invalid field, in reading order; nothing is sent.
      const first = next.cardsPerDay ? cardsId : next.parallelAgents ? parallelId : noteId;
      document.getElementById(first)?.focus();
      return;
    }

    const mySeq = ++sendSeq.current;
    setSending(true);
    const result = await sendEnterpriseRequest(orgId, {
      cardsPerDay: cards === 'invalid' ? null : cards,
      parallelAgents: parallel === 'invalid' ? null : parallel,
      agentPath,
      autonomy,
      startWhen,
      teamSize,
      contact: contact.trim() === '' ? null : contact.trim(),
      note: note.trim(),
    });
    if (mySeq !== sendSeq.current) return;

    if (result.kind === 'sent') {
      // The card re-reads the open request from the server rather than
      // assuming it; the dialog confirms with the contact the server stored.
      const fresh = await onRequestChanged();
      if (mySeq !== sendSeq.current) return;
      setShown(fresh ?? result.request);
      setSentContact(result.request.contact);
      setSending(false);
      setMode('sent');
      return;
    }
    if (result.kind === 'already_open') {
      // A parallel tab (or another admin) won. Read the request that won, so
      // the alert can date it and "View the request" can open it; the card
      // swaps to "Request sent" from the same read.
      const fresh = await onRequestChanged();
      if (mySeq !== sendSeq.current) return;
      setConflict(fresh ?? null);
      setSending(false);
      setRefusal('open');
      return;
    }
    setSending(false);
    if (result.kind === 'forbidden') {
      setRefusal('forbidden');
    } else if (
      result.kind === 'invalid' &&
      (result.field === 'cardsPerDay' ||
        result.field === 'parallelAgents' ||
        result.field === 'note')
    ) {
      setErrors({
        [result.field]: result.field === 'note' ? t('errors.note') : t('errors.number'),
      });
    } else {
      // Network / 5xx / anything unexpected: nothing was sent, every typed
      // value stays, and Send stays enabled to retry.
      setRefusal('network');
    }
  }

  if (mode === 'sent') {
    return (
      <Modal open={open} onOpenChange={close} size="lg" title={t('sent.title')}>
        <Modal.Body>
          <div className="flex items-start gap-3" data-testid="contact-sales-sent">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--el-tint-mint) text-(--el-text-strong)"
            >
              <Check className="h-4 w-4" />
            </span>
            <p className="font-sans text-sm text-(--el-text)">
              {t.rich('sent.body', {
                contact: sentContact,
                b: (chunks) => <b>{chunks}</b>,
              })}
            </p>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onClick={() => close(false)}>
            {t('done')}
          </Button>
        </Modal.Footer>
      </Modal>
    );
  }

  if (mode === 'request' && shown) {
    return (
      <EnterpriseRequestView
        open={open}
        onClose={() => close(false)}
        request={shown}
        fmtDate={fmtDate}
      />
    );
  }

  const locked = sending;
  const sendBlocked = refusal === 'open' || refusal === 'forbidden';

  return (
    <Modal
      open={open}
      onOpenChange={close}
      size="lg"
      title={t('title')}
      description={t('subtitle')}
      hideClose={sending}
    >
      <Modal.Body className="gap-4">
        <section
          aria-label={t('facts.heading')}
          className="rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding)"
          data-testid="contact-sales-facts"
        >
          <p className="mb-2 font-sans text-xs font-semibold text-(--el-text-secondary)">
            {t('facts.heading')}
          </p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 font-sans text-sm sm:grid-cols-2">
            <Fact k={t('facts.organization')} v={orgName} />
            <Fact k={t('facts.requestedBy')} v={context?.requesterName ?? '—'} />
            <Fact k={t('facts.currentPlan')} v={planName ?? '—'} />
            <Fact k={t('facts.repositories')} v={context ? String(context.repositoryCount) : '—'} />
          </dl>
        </section>

        <p className="font-sans text-xs text-(--el-text-secondary)">{t('optionalNote')}</p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            id={cardsId}
            label={t('fields.cardsPerDay')}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            placeholder={t('fields.cardsPerDayPlaceholder')}
            value={cardsPerDay}
            onChange={(e) => setCardsPerDay(e.target.value)}
            error={errors.cardsPerDay}
            disabled={locked}
          />
          <Input
            id={parallelId}
            label={t('fields.parallelAgents')}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            placeholder={t('fields.parallelAgentsPlaceholder')}
            value={parallelAgents}
            onChange={(e) => setParallelAgents(e.target.value)}
            error={errors.parallelAgents}
            disabled={locked}
          />
        </div>

        <RadioCards
          legend={t('fields.agentPath')}
          name={`${ids}-agent-path`}
          value={agentPath}
          onChange={setAgentPath}
          disabled={locked}
          options={ENTERPRISE_AGENT_PATHS.map((v) => ({
            value: v,
            label: t(`agentPath.${v}.label`),
            hint: t(`agentPath.${v}.hint`),
          }))}
        />
        <RadioCards
          legend={t('fields.autonomy')}
          name={`${ids}-autonomy`}
          value={autonomy}
          onChange={setAutonomy}
          disabled={locked}
          options={ENTERPRISE_AUTONOMIES.map((v) => ({
            value: v,
            label: t(`autonomy.${v}.label`),
            hint: t(`autonomy.${v}.hint`),
          }))}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label={t('fields.startWhen')} htmlFor={`${ids}-when`}>
            <Combobox
              id={`${ids}-when`}
              label={t('fields.startWhen')}
              placeholder={t('fields.choose')}
              searchable={false}
              value={startWhen}
              onChange={setStartWhen}
              disabled={locked}
              options={ENTERPRISE_START_WHENS.map((v) => ({
                value: v,
                label: t(`startWhen.${v}`),
              }))}
            />
          </FormField>
          <FormField label={t('fields.teamSize')} htmlFor={`${ids}-team`}>
            <Combobox
              id={`${ids}-team`}
              label={t('fields.teamSize')}
              placeholder={t('fields.choose')}
              searchable={false}
              value={teamSize}
              onChange={setTeamSize}
              disabled={locked}
              options={ENTERPRISE_TEAM_SIZES.map((v) => ({ value: v, label: t(`teamSize.${v}`) }))}
            />
          </FormField>
        </div>

        <Input
          label={t('fields.contact')}
          helperText={t('fields.contactHelp')}
          value={contact}
          maxLength={ENTERPRISE_REQUEST_LIMITS.maxContactLength}
          onChange={(e) => setContact(e.target.value)}
          disabled={locked}
        />

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={noteId}
            className="flex items-center gap-2 font-sans text-sm font-medium text-(--el-text)"
          >
            {t('fields.note')}
            <span className="font-sans text-xs font-normal text-(--el-text-secondary)">
              {t('fields.required')}
            </span>
          </label>
          <Textarea
            id={noteId}
            rows={3}
            autoGrow
            maxRows={10}
            required
            maxLength={ENTERPRISE_REQUEST_LIMITS.maxNoteLength}
            placeholder={t('fields.notePlaceholder')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            error={errors.note}
            disabled={locked}
          />
        </div>

        {refusal === 'open' ? (
          <RefusalBox icon={<AlertCircle className="h-4 w-4" />} title={t('refused.open.title')}>
            {conflict
              ? t('refused.open.body', { date: fmtDate(conflict.createdAt) })
              : t('refused.open.bodyNoDate')}{' '}
            {conflict ? (
              <button
                type="button"
                className="font-medium underline"
                onClick={() => {
                  setShown(conflict);
                  setMode('request');
                }}
              >
                {t('refused.open.action')}
              </button>
            ) : null}
          </RefusalBox>
        ) : null}
        {refusal === 'forbidden' ? (
          <RefusalBox
            icon={<Lock className="h-4 w-4" />}
            title={t('refused.forbidden.title', { org: orgName })}
          >
            {t('refused.forbidden.body')}
          </RefusalBox>
        ) : null}
        {refusal === 'network' ? (
          <RefusalBox icon={<WifiOff className="h-4 w-4" />} title={t('refused.network.title')}>
            {t('refused.network.body')}
          </RefusalBox>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={() => close(false)} disabled={locked}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          loading={sending}
          disabled={sendBlocked}
          leftIcon={sending ? undefined : <Send className="h-4 w-4" />}
        >
          {sending ? t('sending') : t('send')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function Fact({ k, v, unset }: { k: string; v: string; unset?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-(--el-text-secondary)">{k}</dt>
      <dd className={unset ? 'text-(--el-text-secondary)' : 'text-(--el-text)'}>{v}</dd>
    </div>
  );
}

/** `FormField`'s `errorVariant="box"` alert, with the refusal's glyph and title (panel 8). */
function RefusalBox({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-danger-surface) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs text-(--el-danger-surface-text)"
    >
      <span aria-hidden className="mt-0.5 shrink-0">
        {icon}
      </span>
      <p>
        <strong>{title}</strong> {children}
      </p>
    </div>
  );
}

/**
 * The radio-card group — the shipped `components/approvals/RefusalReason.tsx`
 * verdict grammar (a `radiogroup` labelled by its legend, visually-hidden
 * radios, a 16px dot, label + hint), laid out one per row because the hints
 * are a sentence long. Optional: it starts unset and stays unset until chosen.
 */
function RadioCards<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  disabled,
}: {
  legend: string;
  name: string;
  value: T | null;
  onChange: (value: T) => void;
  options: { value: T; label: string; hint: string }[];
  disabled: boolean;
}) {
  const legendId = `${name}-legend`;
  return (
    <div className="flex flex-col gap-1.5">
      <p id={legendId} className="font-sans text-sm font-medium text-(--el-text)">
        {legend}
      </p>
      <div role="radiogroup" aria-labelledby={legendId} className="flex flex-col gap-2">
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              data-value={option.value}
              className={`flex gap-3 rounded-(--radius-card) border px-3 py-2.5 ${
                disabled
                  ? 'cursor-not-allowed border-(--el-input-disabled-border) bg-(--el-input-disabled-bg)'
                  : `cursor-pointer hover:bg-(--el-surface) ${
                      selected
                        ? 'border-(--el-accent) bg-(--el-surface-soft)'
                        : 'border-(--el-border) bg-(--el-page-bg)'
                    }`
              }`}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                disabled={disabled}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border bg-(--el-page-bg) ${
                  selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
                }`}
              >
                {selected ? <span className="h-2 w-2 rounded-full bg-(--el-accent)" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm font-medium ${
                    disabled ? 'text-(--el-input-disabled-text)' : 'text-(--el-text)'
                  }`}
                >
                  {option.label}
                </span>
                {option.hint ? (
                  <span
                    className={`mt-0.5 block text-[13px] leading-snug ${
                      disabled ? 'text-(--el-input-disabled-text)' : 'text-(--el-text-secondary)'
                    }`}
                  >
                    {option.hint}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** The org's open request, read-only (panel 7): no form, no edit, one Close. */
function EnterpriseRequestView({
  open,
  onClose,
  request,
  fmtDate,
}: {
  open: boolean;
  onClose: () => void;
  request: EnterpriseRequestDTO;
  fmtDate: (iso: string) => string;
}) {
  const t = useTranslations('billing.contactSales');
  const date = fmtDate(request.createdAt);
  const unset = t('request.unset');
  const answer = (v: string | null) => (v === null ? { v: unset, unset: true } : { v });
  const status = request.status === 'closed' ? null : request.status;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title={t('request.title')}
      description={
        request.requestedByName
          ? t('request.subtitle', { date, name: request.requestedByName })
          : t('request.subtitleNoName', { date })
      }
    >
      <Modal.Body className="gap-4" data-testid="contact-sales-request">
        {status ? (
          <div className="flex items-center gap-2 font-sans text-sm">
            <span className="text-(--el-text-secondary)">{t('request.state')}</span>
            <Pill className={`border-transparent text-(--el-text-strong) ${STATUS_TINT[status]}`}>
              {t(`request.status.${status}`)}
            </Pill>
          </div>
        ) : null}
        <section
          aria-label={t('request.asked')}
          className="rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding)"
        >
          <p className="mb-2 font-sans text-xs font-semibold text-(--el-text-secondary)">
            {t('request.asked')}
          </p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 font-sans text-sm sm:grid-cols-2">
            <Fact
              k={t('fields.cardsPerDay')}
              {...answer(request.cardsPerDay === null ? null : String(request.cardsPerDay))}
            />
            <Fact
              k={t('fields.parallelAgents')}
              {...answer(request.parallelAgents === null ? null : String(request.parallelAgents))}
            />
            <Fact
              k={t('fields.agentPath')}
              {...answer(request.agentPath && t(`agentPath.${request.agentPath}.label`))}
            />
            <Fact
              k={t('fields.autonomy')}
              {...answer(request.autonomy && t(`autonomy.${request.autonomy}.label`))}
            />
            <Fact
              k={t('fields.startWhen')}
              {...answer(request.startWhen && t(`startWhen.${request.startWhen}`))}
            />
            <Fact
              k={t('fields.teamSize')}
              {...answer(request.teamSize && t(`teamSize.${request.teamSize}`))}
            />
            <Fact k={t('fields.contact')} v={request.contact} />
          </dl>
        </section>
        <div className="flex flex-col gap-1.5">
          <p className="font-sans text-sm font-medium text-(--el-text)">{t('fields.note')}</p>
          <blockquote className="border-l-2 border-(--el-border-strong) pl-3 font-sans text-sm whitespace-pre-wrap text-(--el-text)">
            {request.note}
          </blockquote>
        </div>
        <p className="flex items-start gap-2 font-sans text-xs text-(--el-text-secondary)">
          <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {t.rich('request.reply', {
              contact: request.contact,
              b: (chunks) => <b>{chunks}</b>,
            })}
          </span>
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('close')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
