'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { GithubMark } from '@/components/icons/GithubMark';
import { ConnectGithubFlow } from './ConnectGithubFlow';
import { DisconnectAccountDialog } from './DisconnectAccountDialog';
import { GitAccountList } from './GitAccountList';
import type { GithubAccountRef, LinkedGithubAccount } from './githubAccounts';

// THE GITHUB CONNECTION CARD and the two dialogs it opens (Story MOTIR-8216 ·
// MOTIR-8223) — the client half of the room's GitHub arm. The page reads the
// linked accounts on the server and hands them here; this file owns only which
// dialog is open, and on a successful link or disconnect it re-reads the server
// half with ONE `router.refresh()`.
//
// ⚠️ THE NOT-CONNECTED PANEL STAYS SERVER-RENDERED. It arrives as `children`,
// and its one interactive piece — the `Connect GitHub` button that USED to be an
// `<a target=_blank>` to GitHub's install page — is `ConnectGithubButton`, which
// opens the picker through the context below. Leaving for GitHub is now a choice
// made INSIDE the picker (its last row), never the first click (design § 31.4).

interface RoomActions {
  openPicker: () => void;
}

const RoomContext = createContext<RoomActions | null>(null);

/** The not-connected panel's primary: opens the account picker. */
export function ConnectGithubButton() {
  const t = useTranslations('github.accounts');
  const room = useContext(RoomContext);
  return (
    <Button type="button" variant="primary" onClick={() => room?.openPicker()}>
      <GithubMark className="h-4 w-4" aria-hidden />
      {t('connect')}
    </Button>
  );
}

export interface GithubConnectRoomProps {
  organizationId: string;
  organizationName: string;
  accounts: LinkedGithubAccount[];
  /** `?github=select_repos&installation_id=…` — open that account's repo picker. */
  selectReposInstallationId: string | null;
  /** The not-connected panel, server-rendered; shown when `accounts` is empty. */
  children: ReactNode;
}

export function GithubConnectRoom({
  organizationId,
  organizationName,
  accounts,
  selectReposInstallationId,
  children,
}: GithubConnectRoomProps) {
  const router = useRouter();
  const t = useTranslations('github.accounts');
  const { toast } = useToast();
  // The round trip's picker opens in the SAME paint as its banner (§ A6c).
  const [pickerOpen, setPickerOpen] = useState(selectReposInstallationId !== null);
  const [pickerAccount, setPickerAccount] = useState<GithubAccountRef | null>(null);
  const [pendingInstallation, setPendingInstallation] = useState(selectReposInstallationId);
  const [disconnecting, setDisconnecting] = useState<GithubAccountRef | null>(null);
  // One key per open, so each open of the picker starts from fresh state.
  const [pickerSession, setPickerSession] = useState(0);

  const openPicker = useCallback(() => {
    setPickerAccount(null);
    setPendingInstallation(null);
    setPickerSession((n) => n + 1);
    setPickerOpen(true);
  }, []);

  const openRepoPicker = (account: GithubAccountRef) => {
    setPickerAccount(account);
    setPendingInstallation(null);
    setPickerSession((n) => n + 1);
    setPickerOpen(true);
  };

  const onLinked = ({ account, count }: { account: GithubAccountRef; count: number }) => {
    setPickerOpen(false);
    toast({
      variant: 'success',
      title: t('toastTitle', { count, account: account.accountLogin }),
      description: t('toastBody', { org: organizationName }),
    });
    router.refresh();
  };

  return (
    <RoomContext.Provider value={{ openPicker }}>
      <Card>
        {accounts.length > 0 ? (
          <GitAccountList
            accounts={accounts}
            organizationName={organizationName}
            onConnect={openPicker}
            onAddOrRemove={openRepoPicker}
            onDisconnect={setDisconnecting}
          />
        ) : (
          children
        )}
      </Card>
      <ConnectGithubFlow
        key={pickerSession}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        organizationId={organizationId}
        organizationName={organizationName}
        initialAccount={pickerAccount}
        initialInstallationId={pendingInstallation}
        onLinked={onLinked}
      />
      <DisconnectAccountDialog
        key={disconnecting?.installationId ?? 'closed'}
        account={disconnecting}
        organizationName={organizationName}
        onClose={() => setDisconnecting(null)}
        onDone={() => {
          setDisconnecting(null);
          router.refresh();
        }}
      />
    </RoomContext.Provider>
  );
}
