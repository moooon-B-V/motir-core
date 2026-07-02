'use client';

// i18n-injecting wrapper over the framework-agnostic `@motir/design-system`
// Modal (MOTIR-1527). The package dropped its `next-intl` dependency and now
// takes the close/dialog accessible labels as props (English defaults); this
// shim supplies motir-core's translated `common.close` / `common.dialog`, so
// every existing `<Modal>` call site stays localized without any change. The
// compound sub-components (`Modal.Body` / `Modal.Footer` / `Modal.Trigger`) are
// re-attached so `<Modal.Footer>` etc. keep working.
import { useTranslations } from 'next-intl';
import { Modal as BaseModal, type ModalProps } from '@motir/design-system';

function LocalizedModal(props: ModalProps) {
  const tc = useTranslations('common');
  // Defaults first so an explicit caller-supplied label still overrides them.
  return <BaseModal closeLabel={tc('close')} dialogLabel={tc('dialog')} {...props} />;
}

export const Modal = Object.assign(LocalizedModal, {
  Body: BaseModal.Body,
  Footer: BaseModal.Footer,
  Trigger: BaseModal.Trigger,
});

export type { ModalProps };
