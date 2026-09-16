import * as z from 'zod';
import { issueNumber, type IssueManager } from './issues';
import type { ConnectorTool } from './types';

/** Only issue reads enter the investigator tool surface; writes use the confirmation service.
 * @param issues - Provider-specific scoped issue port.
 */
export function issueReadTools(issues: IssueManager): ConnectorTool[] {
  const search = z.object({
    repository: z.string().min(1).max(255),
    query: z.string().max(255).optional(),
    state: z.enum(['open', 'closed']).optional(),
  });
  const get = z.object({ repository: z.string().min(1).max(255), number: issueNumber });
  return [
    {
      name: 'search_issues',
      description:
        'Read up to 50 recent repository issues. GitHub query filtering covers this bounded recent page, not all history. Use get_issue for an exact number. This never writes.',
      inputSchema: search,
      run: (input: unknown) => {
        const value = search.parse(input);
        return issues.list(value.repository, value.query, value.state);
      },
    },
    {
      name: 'get_issue',
      description: 'Read one exact issue number within an admitted repository. This never writes.',
      inputSchema: get,
      run: (input: unknown) => {
        const value = get.parse(input);
        return issues.get(value.repository, value.number);
      },
    },
  ];
}
