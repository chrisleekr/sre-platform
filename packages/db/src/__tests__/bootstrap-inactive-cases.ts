import { test, expect } from 'vitest';
import type { DbHandle } from '../client';
import { runBootstrap, formatBootstrapReport } from '../bootstrap';
import { fixture, bootstrapEnv, discovery } from './bootstrap-test-support';

export function registerInactiveBootstrapCases(getAdmin: () => DbHandle) {
  test.each(['disabled', 'deleted'] as const)(
    'reports a %s administrator and continues remaining declarations',
    async (status) => {
      const admin = getAdmin();
      const value = fixture(`inactive-${status}`);
      await admin.sql`insert into users (issuer, subject, email, status) values (${value.provider.issuer}, ${value.subjectAdmin.subject}, null, ${status})`;
      const nextAdmin = { subject: `${value.marker}|next-admin` };
      for (const iteration of [0, 1]) {
        const report = await runBootstrap(
          bootstrapEnv(value, [value.subjectAdmin, nextAdmin, value.emailAdmin]),
          discovery(value),
        );
        expect(report.admins).toEqual([
          { kind: 'unusable', subject: value.subjectAdmin.subject, reason: 'inactive account' },
          expect.objectContaining({
            kind: 'granted',
            subject: nextAdmin.subject,
            operator: iteration ? 'already granted' : 'granted',
          }),
          {
            kind: 'invited',
            email: value.emailAdmin.email,
            invitation: iteration ? 'already present' : 'created',
          },
        ]);
        expect(formatBootstrapReport(report)).toContain(
          `Platform administrator ${value.subjectAdmin.subject}: unusable (inactive account)`,
        );
      }
      expect(
        await admin.sql`select status, email from users where issuer = ${value.provider.issuer} and subject = ${value.subjectAdmin.subject}`,
      ).toEqual([{ status, email: null }]);
      expect(
        await admin.sql`select po.user_id from platform_operators po join users u on u.id = po.user_id where u.issuer = ${value.provider.issuer} and u.subject = ${value.subjectAdmin.subject}`,
      ).toHaveLength(0);
    },
  );
}
