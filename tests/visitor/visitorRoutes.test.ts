import { describe, expect, it } from 'vitest';
import {
  VISITOR_VIEWS,
  memberPathForVisitorPath,
  parseVisitorPath,
  visitorPathForMemberPath,
  visitorViewPath,
} from '@/lib/visitor/routes';

// The Visitor's address table (Story MOTIR-6170 · MOTIR-6648; design MOTIR-6641
// panel 5): which `/p/<identifier>/<view>` paths the app serves, the member route
// each one is (the `enter` redirect), and the Visitor path a member href followed
// from a Visitor view is sent to.

describe('parseVisitorPath — the ten served shapes, and nothing else', () => {
  it.each([
    ['/p/ACME/board', 'board', null],
    ['/p/ACME/items', 'items', null],
    ['/p/ACME/items/ACME-7', 'items', 'ACME-7'],
    ['/p/ACME/tree', 'tree', null],
    ['/p/ACME/roadmap', 'roadmap', null],
    ['/p/ACME/requested-features', 'requested-features', null],
    ['/p/ACME/plans', 'plans', null],
    ['/p/ACME/plans/cplan123', 'plans', 'cplan123'],
    ['/p/ACME/approvals', 'approvals', null],
    ['/p/ACME/runs/', 'runs', null],
  ])('%s', (path, view, sub) => {
    expect(parseVisitorPath(path)).toEqual({ identifier: 'ACME', view, sub });
  });

  it.each([
    '/p/ACME',
    '/p/ACME/',
    '/p/ACME/changelog',
    '/p/ACME/consent',
    '/p/ACME/enter',
    '/p/ACME/board/extra',
    '/p/ACME/items/ACME-7/more',
    '/p/ACME/tree/x',
    '/p/ACME/requests',
    '/items',
    '/p',
  ])('%s is not a Visitor view', (path) => {
    expect(parseVisitorPath(path)).toBeNull();
  });

  it('lists the seven views the rail and the switch address', () => {
    expect([...VISITOR_VIEWS].sort()).toEqual(
      [
        'approvals',
        'board',
        'items',
        'plans',
        'requested-features',
        'roadmap',
        'runs',
        'tree',
      ].sort(),
    );
  });

  it('decodes the identifier and the sub-segment, and refuses a malformed one', () => {
    expect(parseVisitorPath('/p/AC%2DME/items/AC%2DME-1')).toEqual({
      identifier: 'AC-ME',
      view: 'items',
      sub: 'AC-ME-1',
    });
    expect(parseVisitorPath('/p/%E0%A4%A/board')).toBeNull();
  });
});

describe('memberPathForVisitorPath — the `enter` redirect (card mapping)', () => {
  it.each([
    ['/p/ACME/board', '/boards'],
    ['/p/ACME/items', '/items?view=list'],
    ['/p/ACME/tree', '/items?view=tree'],
    ['/p/ACME/roadmap', '/roadmap'],
    // MOTIR-6769 — a member lands in their own inbox, renamed by MOTIR-6772.
    ['/p/ACME/requested-features', '/requested-features'],
    ['/p/ACME/items/ACME-7', '/items/ACME-7'],
    ['/p/ACME/plans', '/plans'],
    ['/p/ACME/plans/cplan123', '/plans/cplan123'],
    ['/p/ACME/approvals', '/approvals'],
    ['/p/ACME/runs', '/runs'],
  ])('%s → %s', (from, to) => {
    expect(memberPathForVisitorPath(from)).toBe(to);
  });

  it('keeps the query, and the path decides list vs tree over any ?view=', () => {
    expect(memberPathForVisitorPath('/p/ACME/board?board=b1&peek=ACME-2')).toBe(
      '/boards?board=b1&peek=ACME-2',
    );
    expect(memberPathForVisitorPath('/p/ACME/tree?view=list&sort=key')).toBe(
      '/items?view=tree&sort=key',
    );
  });

  it('answers null for anything that is not a Visitor view', () => {
    expect(memberPathForVisitorPath('/p/ACME')).toBeNull();
    expect(memberPathForVisitorPath('/p/ACME/consent?next=/p/ACME/board')).toBeNull();
  });
});

describe('visitorPathForMemberPath — a shared body’s member href, followed from a Visitor view', () => {
  it.each([
    ['/items', '', '/p/ACME/items'],
    ['/items', '?view=tree&sort=key', '/p/ACME/tree?sort=key'],
    ['/items', '?view=list', '/p/ACME/items'],
    ['/items/ACME-7', '', '/p/ACME/items/ACME-7'],
    ['/items/ACME-7', '?activity=comments', '/p/ACME/items/ACME-7?activity=comments'],
    ['/boards', '?board=b1', '/p/ACME/board?board=b1'],
    ['/roadmap', '?item=ACME-3', '/p/ACME/roadmap?item=ACME-3'],
    ['/requested-features', '', '/p/ACME/requested-features'],
    ['/plans', '?planState=approved', '/p/ACME/plans?planState=approved'],
    ['/plans/cplan1', '', '/p/ACME/plans/cplan1'],
    ['/approvals', '?page=2', '/p/ACME/approvals?page=2'],
    ['/runs', '?scope=ACME-4', '/p/ACME/runs?scope=ACME-4'],
  ])('%s%s → %s', (pathname, search, to) => {
    expect(visitorPathForMemberPath('ACME', pathname, search)).toBe(to);
  });

  it.each([
    '/settings/account',
    '/workbench',
    '/dashboard',
    '/backlog',
    '/boards/x',
    '/runs/r1',
    '/items/ACME-7/edit',
  ])('%s has no Visitor view and is left alone', (pathname) => {
    expect(visitorPathForMemberPath('ACME', pathname, '')).toBeNull();
  });

  it('round-trips with the enter mapping', () => {
    for (const path of ['/p/ACME/board', '/p/ACME/tree', '/p/ACME/items/ACME-7', '/p/ACME/runs']) {
      const member = memberPathForVisitorPath(path)!;
      const [pathname, search = ''] = member.split('?');
      const back = visitorPathForMemberPath('ACME', pathname!, search);
      expect(back?.split('?')[0]).toBe(path);
    }
  });

  it('visitorViewPath encodes what it is given', () => {
    expect(visitorViewPath('A B', 'items', 'A B-1')).toBe('/p/A%20B/items/A%20B-1');
  });
});
