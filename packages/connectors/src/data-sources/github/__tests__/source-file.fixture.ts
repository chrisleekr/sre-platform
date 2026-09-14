import type { Reply } from './test-helpers';

export const sourceRevision = 'a'.repeat(40);
export const sourceBlob = 'b'.repeat(40);

/** A pinned commit and nonrecursive trees, with Contents retaining GitHub's symlink behavior. */
export function sourceFileReply(
  url: string,
  path: string,
  text: string,
  options: { mode?: string; truncated?: boolean; parentSymlink?: boolean } = {},
): Reply {
  const parts = path.split('/');
  const treeSha = (index: number) => String(index + 1).repeat(40);
  if (url.endsWith(`/git/commits/${sourceRevision}`))
    return { status: 200, json: { sha: sourceRevision, tree: { sha: treeSha(0) } } };
  if (url.includes('/commits/')) return { status: 200, json: { sha: sourceRevision } };
  for (let index = 0; index < parts.length; index++) {
    if (!url.endsWith(`/git/trees/${treeSha(index)}`)) continue;
    const leaf = index === parts.length - 1;
    return {
      status: 200,
      json: {
        truncated: options.truncated ?? false,
        tree: [
          {
            path: parts[index],
            type: leaf || options.parentSymlink ? 'blob' : 'tree',
            mode: leaf ? (options.mode ?? '100644') : options.parentSymlink ? '120000' : '040000',
            sha: leaf ? sourceBlob : treeSha(index + 1),
          },
        ],
      },
    };
  }
  if (url.endsWith(`/git/blobs/${sourceBlob}`) || url.includes(`/contents/${path}`))
    return {
      status: 200,
      json: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') },
    };
  return { status: 404 };
}
