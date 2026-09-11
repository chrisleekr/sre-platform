import type { CredentialGetter } from './request-credentials';
import { useEffect, useMemo, useState } from 'react';
import {
  investigationSubjectKey,
  listActiveInvestigations,
  type InvestigationSubject,
} from './investigations';

export function useInvestigationWorkspaces(args: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  subjects: InvestigationSubject[];
}) {
  const key = useMemo(
    () => args.subjects.map(investigationSubjectKey).sort().join('|'),
    [args.subjects],
  );
  const [active, setActive] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let current = true;
    void listActiveInvestigations(args.apiBaseUrl, args.getCredentials, args.subjects)
      .then((result) => {
        if (current) setActive(result);
      })
      .catch(() => {
        if (current) setActive(new Map());
      });
    return () => {
      current = false;
    };
  }, [args.apiBaseUrl, args.getCredentials, key]);
  return active;
}
